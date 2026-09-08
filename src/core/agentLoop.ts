import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { AgentMode, AutoApproveMode, ChatMessage, CustomMode, ModeSwitchRequest, TodoItem, ApprovalResponse, TokenUsage } from '../types';
import { FibonacciClient } from '../api/fibonacciClient';
import { ToolRegistry, type ToolContext } from './toolRegistry';
import { ApprovalManager, describeToolCall } from './approvalManager';
import { parseToolCalls } from './toolParser';
import { buildSystemPrompt, type ToolFormat, ENFORCEMENT_RETRY_PROMPT } from './systemPrompt';
import { formatToolResponseBlock } from './hermesTemplate';
import { PREVIEW_TOOLS, previewToolCall, commitPreview, revertPreview, type PreviewHandle } from './filePreview';
import { LiveCodeStreamer } from './liveCoder';
import { FILE_MUTATING_TOOLS, computeFileEditDiff, countDiffStats } from './diffPreview';
import { buildFallbackFile } from './fallbackTemplates';
import { enforceBudget } from './contextBudget';
import { estimateCostUsd } from './pricing';
import { resolveMentions } from './mentions';
import { buildRepoMap } from './repoMap';
import type { SkillsRegistry } from './skillsRegistry';

interface AgentLoopDeps {
  client: FibonacciClient;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  autoApproveMode: AutoApproveMode;
  skills: SkillsRegistry;
  callbacks: {
    onAssistantStart: () => string;
    onAssistantContent: (id: string, content: string, reasoning?: string) => void;
    onAssistantEnd: (id: string, content: string, reasoning?: string, usage?: TokenUsage) => void;
    onAssistantRemove: (id: string) => void;
    onToolStart: (msg: ChatMessage) => void;
    onToolEnd: (msg: ChatMessage) => void;
    /** Kilo-style diff support: hand the pre-execution before/after to the provider (cache for re-open). */
    onToolDiffData?: (messageId: string, path: string, before: string, after: string) => void;
    onTodosUpdate: (todos: TodoItem[]) => void;
    onModeSwitchRequest: (request: ModeSwitchRequest) => Promise<boolean>;
    onError: (err: string) => void;
    /**
     * Coverage for the PREVIEW-approval commit path (the registry
     * beforeTool hook only fires on registry.execute()). Awaited immediately
     * BEFORE each commitPreview() — e.g. snapshot checkpoints.
     */
    beforePreviewCommit?: (toolName: string, args: Record<string, unknown>) => Promise<void>;
    /**
     * Awaited AFTER commitPreview() succeeds. The returned string (when
     * non-empty) is appended to the tool message content/toolResult with the
     * same "\n\n" prefix convention as the registry afterTool hook — e.g.
     * auto-diagnostics. Errors must be caught inside the implementation.
     */
    afterPreviewCommit?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  };
}

/**
 * The AgentLoop runs the chat → tool-call → tool-result → chat cycle.
 *
 * It is responsible for:
 *  - converting ChatMessage[] to OpenAI message format
 *  - calling the Fibonacci LLM
 *  - requesting approval for each tool call
 *  - executing tools and feeding results back (in Hermes <|tool_response> format)
 *  - enforcing maxIterations
 *  - switching between Coding mode and Plan mode system prompts
 *  - extracting and surfacing the model's reasoning channel
 *  - retrying when the model emits code-in-chat instead of a tool call
 */
export class AgentLoop {
  private abortController: AbortController | null = null;
  private language: 'fa' | 'en' = 'fa';

  constructor(private deps: AgentLoopDeps) {}

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  get isRunning(): boolean {
    return this.abortController !== null;
  }

  async run(
    history: ChatMessage[],
    model: string,
    workspaceRoot: string,
    initialMode: AgentMode,
    onModeChanged?: (newMode: AgentMode) => void,
    /** Optional connected-provider credentials — when set, every API call of
     *  this run routes through that OpenAI-compatible endpoint instead of the
     *  global fibonacci baseURL/apiKey (Providers-tab routing). */
    provider?: { baseURL: string; apiKey: string } | null
  ): Promise<ChatMessage[]> {
    this.abortController = new AbortController();
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    const maxIterations = cfg.get<number>('maxIterations') ?? 25;
    const hermesMode = cfg.get<boolean>('hermesMode') ?? true;
    const showReasoning = cfg.get<boolean>('showReasoning') ?? true;
    const language = (cfg.get<string>('language') as 'fa' | 'en') ?? 'fa';
    this.language = language;

    const ctx: ToolContext = {
      workspaceRoot,
      log: () => {},
      signal: this.abortController.signal,
    };

    // Mutable mode — can be changed mid-run via request_mode_switch.
    let currentMode: AgentMode = initialMode;
    const applyMode = (mode: AgentMode) => {
      currentMode = mode;
      onModeChanged?.(mode);
    };

    // Strip mode tags from user messages so the LLM doesn't see them, and
    // FIX (mode protocol mismatch): recognize ALL mode tags — previously only
    // [PLAN MODE] was stripped while [ASK/DEBUG/AUTO MODE] leaked verbatim
    // into prompts and never switched the host-side mode. The tag slug is
    // open-ended so CUSTOM user-mode ids (e.g. [MY-MODE MODE], produced by
    // buildModeTag for any non-coding mode) are stripped too.
    const MODE_TAG_RE = /^\[[A-Z0-9_-]+ MODE\]\s*/i;
    const cleanedHistory = history.map((m) => {
      if (m.role !== 'user') return m;
      const match = m.content.match(MODE_TAG_RE);
      return match
        ? { ...m, content: m.content.replace(MODE_TAG_RE, '') }
        : m;
    });

    // Project rules (.fibonaccirules*) — read once per run, cached by mtime.
    let rulesText = '';
    try {
      rulesText = loadRules(workspaceRoot);
    } catch {
      rulesText = '';
    }

    // Repo map (compact symbol outline) — built once per run, 90s-cached
    // inside buildRepoMap. Non-fatal: on any error we just omit the section.
    let repoMapText = '';
    try {
      const repoMapEnabled = cfg.get<boolean>('repoMap') ?? true;
      if (workspaceRoot && repoMapEnabled) {
        repoMapText = await buildRepoMap(workspaceRoot);
      }
    } catch {
      repoMapText = '';
    }

    // Custom user modes (Settings → Modes): when the active mode matches a
    // CustomMode.id, its prompt is injected as a system-prompt section (base
    // mode falls back to 'coding') and its optional tool whitelist filters
    // the OpenAI tool list offered to the model.
    let customModes: CustomMode[] = [];
    try {
      customModes = cfg.get<CustomMode[]>('customModes') ?? [];
    } catch {
      customModes = [];
    }
    const resolveCustomMode = (mode: AgentMode): CustomMode | undefined =>
      customModes.find((m) => m && m.id === mode);

    // @-mention expansion on the LAST user message of the run (copy-on-write,
    // non-fatal — on any error keep the original content).
    try {
      for (let i = cleanedHistory.length - 1; i >= 0; i--) {
        if (cleanedHistory[i].role === 'user') {
          const resolved = await resolveMentions(cleanedHistory[i].content, workspaceRoot);
          if (resolved.content !== cleanedHistory[i].content) {
            cleanedHistory[i] = { ...cleanedHistory[i], content: resolved.content };
          }
          break;
        }
      }
    } catch {
      /* keep original */
    }

    const buildMessages = (): ChatCompletionMessageParam[] => {
      const toolFormat: ToolFormat = hermesMode ? 'hermes' : 'xml';
      const custom = resolveCustomMode(currentMode);
      const systemPrompt = buildSystemPrompt({
        // A custom mode rides on the coding-mode prompt (full tool access
        // semantics) — its own directives arrive via customModeText.
        mode: custom ? 'coding' : currentMode,
        toolFormat,
        skills: this.deps.skills.list(),
        workspaceRoot,
        language,
        currentDate: new Date().toISOString().slice(0, 10),
        modelName: model,
        maxIterations,
        enableReasoning: showReasoning,
        rulesText,
        customModeText: custom?.prompt,
        repoMapText,
      });
      return [
        { role: 'system', content: systemPrompt },
        ...cleanedHistory.map((m) => this.toOpenAIMessage(m, hermesMode)),
      ];
    };

    let messages: ChatCompletionMessageParam[] = buildMessages();

    // Build the OpenAI tools array from the registry. We only pass `tools` to
    // the API when forceToolRetry is true (enforcement retry with
    // tool_choice: 'required'). On normal calls, we do NOT pass `tools` — the
    // model uses Hermes/XML text format for tool calls, which the parser
    // already handles. This avoids API compatibility issues (some APIs don't
    // fully support the `tools` parameter or have limits on tool count/schema
    // size) and matches the original v1.0.3 behavior.
    //
    // A custom mode's optional tool whitelist is applied here: when the
    // active mode defines `tools`, only those tool names are offered. If the
    // whitelist matches NOTHING we fall back to ALL tools (safety — a custom
    // mode must never strand the model without a usable tool). Re-evaluated
    // per iteration so a mid-run mode switch (request_mode_switch) lifts or
    // re-applies the whitelist together with the rebuilt system prompt.
    const openaiToolsForMode = (): ReturnType<ToolRegistry['toOpenAITools']> => {
      const all = this.deps.registry.toOpenAITools();
      const custom = resolveCustomMode(currentMode);
      if (custom?.tools?.length) {
        const allowed = new Set(custom.tools);
        const filtered = all.filter((t) => allowed.has(t.function.name));
        if (filtered.length > 0) return filtered;
      }
      return all;
    };

    // Track enforcement retries so we don't loop forever.
    let enforcementRetries = 0;
    const MAX_ENFORCEMENT_RETRIES = 3;

    try {
      let forceToolRetry = false;
      let allToolsBlocked = false;  // After ANY rejection, block ALL subsequent tool calls
      let blockedToolName = '';    // The name of the tool that was rejected
      let shouldStop = false;      // After blocking + one final response, stop the loop

      // CRITICAL FIX (bug I — infinite rewrite loop):
      // Track files that have been successfully written in this run. If the
      // model tries to write the SAME file again with the SAME content, we
      // detect it and stop the loop instead of re-writing endlessly.
      // This happens when the model sees a truncated tool result and thinks
      // the file wasn't written correctly.
      const writtenFiles = new Map<string, { content: string; toolName: string }>();

      for (let i = 0; i < maxIterations; i++) {
        if (this.abortController.signal.aborted || shouldStop) break;

        const assistantId = this.deps.callbacks.onAssistantStart();
        let rawBuffer = '';
        let lastThinking = '';

        // Create a LiveCodeStreamer for this iteration. It watches the
        // streaming text and, when a file-writing tool call is detected,
        // opens the editor and shows code appearing in REAL-TIME.
        const liveCoder = new LiveCodeStreamer(workspaceRoot);

        // On enforcement retry, use tool_choice: 'required' to FORCE the API
        // to emit a structured tool_call (not text). We also pass the `tools`
        // array ONLY on retry — not on normal calls. This avoids API
        // compatibility issues while still being able to force tool use when
        // the model hallucinates.
        const toolChoice = forceToolRetry
          ? ('required' as const)
          : undefined;
        // Only pass tools when forcing a retry. On normal calls, don't pass
        // tools — the model uses Hermes/XML text format.
        const toolsParam = forceToolRetry ? openaiToolsForMode() : undefined;

        const compression = cfg.get<string>('contextCompression') ?? 'auto';
        if (compression === 'auto') {
          messages = enforceBudget(messages, 120_000, 6);
        } else {
          const totalLen = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
          if (totalLen > 120_000) {
            console.warn(
              `[fibonacci-agent] Context large (${totalLen.toLocaleString()} chars). ` +
              `Start a new chat or switch context compression to auto.`
            );
          }
        }

        const response = await this.deps.client.chat({
          model,
          messages,
          tools: toolsParam,
          toolChoice,
          temperature: 0.3,
          signal: this.abortController.signal,
          ...(provider && provider.baseURL && provider.apiKey
            ? { baseURL: provider.baseURL, apiKey: provider.apiKey }
            : {}),
          onDelta: (delta) => {
            // CRITICAL FIX (bug #2): Wrap the entire onDelta body in try/catch.
            // This callback is invoked synchronously by the OpenAI SDK on every
            // streamed token. If `parseToolCalls` throws (e.g. on malformed
            // Hermes tokens) OR if `liveCoder.processDelta` throws before its
            // own internal try/catch wraps it, the error propagates as an
            // unhandled rejection inside the SDK's stream iterator. The SDK
            // then surfaces it as a generic "rejected promise not handled
            // within 1 second" error in the log, with no useful context.
            try {
              if (typeof delta !== 'string') return; // guard against malformed chunks
              rawBuffer += delta;
              const { prose, thinking } = parseToolCalls(rawBuffer, { streaming: true });
              lastThinking = thinking;
              this.deps.callbacks.onAssistantContent(assistantId, prose, thinking);
              // Feed the delta to the live coder. It will open the editor and
              // show code in real-time if a file-writing tool call is detected
              // in the TEXT stream (Hermes or XML format).
              liveCoder.processDelta(delta, rawBuffer).catch((err) => {
                console.error('[fibonacci-agent] Live coder processDelta error:', err);
              });
            } catch (err) {
              console.error('[fibonacci-agent] onDelta callback error:', err);
            }
          },
          onToolCallDelta: (toolName, argsFragment, fullArgs) => {
            // Feed structured tool_call deltas to the live coder. This handles
            // the OpenAI structured format (when tool_choice is 'required' or
            // 'auto' and the API emits delta.tool_calls).
            // CRITICAL FIX (bug #2): Same defensive wrap as onDelta.
            try {
              liveCoder.processOpenAIDelta(toolName, argsFragment, fullArgs).catch((err) => {
                console.error('[fibonacci-agent] Live coder processOpenAIDelta error:', err);
              });
            } catch (err) {
              console.error('[fibonacci-agent] onToolCallDelta callback error:', err);
            }
          },
        });

        const { calls: textParsedCalls, prose, thinking } = parseToolCalls(response.content);
        // CRITICAL FIX (bug J — thought is cleared):
        // Use the final parse's thinking if non-empty; otherwise fall back
        // to the streaming thinking. NEVER use empty string — that would
        // clear the thinking from the UI.
        const finalThinking = (thinking && thinking.length > 0) ? thinking : lastThinking;

        // Merge structured API tool_calls with text-parsed calls. The API
        // may return tool_calls in the structured `tool_calls` field (when
        // tool_choice is 'required' or 'auto'), OR the model may emit them
        // as Hermes/XML text tokens. We accept both.
        const apiCalls = response.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          raw: '',
        }));
        const parsedCalls = [...apiCalls, ...textParsedCalls];

        // Attach the per-turn token usage (+ estimated USD cost) so the UI can
        // show a cost footnote on this assistant message.
        let usage: TokenUsage | undefined;
        try {
          const costUsd = estimateCostUsd(model, response.usage.promptTokens, response.usage.completionTokens);
          usage = costUsd === undefined
            ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens }
            : { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens, costUsd };
        } catch {
          usage = undefined;
        }
        this.deps.callbacks.onAssistantEnd(assistantId, prose, finalThinking, usage);

        // ── Check for mode-switch request ─────────────────────────────
        const modeSwitchCall = parsedCalls.find((c) => c.name === 'request_mode_switch');
        if (modeSwitchCall) {
          const requestedMode = (modeSwitchCall.args.mode as AgentMode) ?? 'coding';
          const reason = String(modeSwitchCall.args.reason ?? '');
          if (requestedMode !== currentMode) {
            const approved = await this.deps.callbacks.onModeSwitchRequest({
              mode: requestedMode,
              reason,
            });
            if (approved) {
              applyMode(requestedMode);
              messages = buildMessages();
              messages.push({
                role: 'assistant',
                content: response.content || null,
              });
              messages.push({
                role: 'user',
                content: `[Mode switched to ${requestedMode} — the user approved. You may now proceed with the task using the appropriate tools for ${requestedMode} mode.]`,
              });
              continue;
            } else {
              messages.push({
                role: 'assistant',
                content: response.content || null,
              });
              messages.push({
                role: 'user',
                content: `[The user rejected the mode switch. Stay in ${currentMode} mode and continue.]`,
              });
              continue;
            }
          }
        }

        // ── Enforcement: detect "code in chat", "hallucinated completion",
        //    or "asking clarifying questions" instead of tool use ──────────
        const nonModeSwitchCalls = parsedCalls.filter((c) => c.name !== 'request_mode_switch');
        const looksLikeFileRequest = userMessageLooksLikeFileRequest(history);
        const hasCodeBlock = containsCodeBlock(response.content);
        const hasPseudoToolCall = /tool_call>\s*call\s*:/i.test(response.content);
        // Check BOTH prose and thinking for hallucination — the model often
        // writes "file created" in the reasoning channel before/instead of
        // emitting a tool call.
        const hasHallucination = hallucinatedFileCompletion(prose) || hallucinatedFileCompletion(finalThinking);
        const isAsking = askingClarifyingQuestion(prose) || askingClarifyingQuestion(finalThinking);

        if (
          currentMode !== 'plan' &&
          currentMode !== 'ask' &&
          nonModeSwitchCalls.length === 0 &&
          looksLikeFileRequest &&
          !allToolsBlocked &&  // Don't enforce if tools are blocked
          (hasCodeBlock || hasPseudoToolCall || hasHallucination || isAsking)
        ) {
          // Keep the assistant message visible. Previously this code removed
          // the message via onAssistantRemove, which caused user-visible
          // AI responses to disappear in many common cases (any prose with a
          // code block, any clarifying question, ANY mention of
          // "file created" — including normal explanations). The message stays
          // in the visible chat AND in the in-memory `messages` array we send
          // to the API; we only inject a follow-up user message asking the
          // agent to also emit a real tool call.
          //

          // If we've exhausted retries, fall back to directly creating a
          // default file so the user gets SOMETHING rather than a loop of
          // hallucinations. But only if tools aren't blocked.
          if (enforcementRetries >= MAX_ENFORCEMENT_RETRIES && !allToolsBlocked) {
            const fallbackResult = await this.createFallbackFile(history, ctx, this.language);
            messages.push({
              role: 'assistant',
              content: response.content || null,
            });
            messages.push({
              role: 'user',
              content: this.formatToolResult('write_to_file', fallbackResult.output, hermesMode),
            });
            forceToolRetry = false;
            enforcementRetries = 0;
            continue;
          }

          enforcementRetries++;

          // Build a targeted enforcement prompt based on what went wrong.
          let enforcementMsg = '';
          if (hasHallucination) {
            enforcementMsg = `CRITICAL ERROR: You claimed a file was created but you did NOT actually emit a tool call. This is a HALLUCINATION. The file was NOT created. You MUST emit the write_to_file tool call NOW. The system has forced tool_choice=required, so the API will ONLY accept a tool call — text responses will be rejected. Pick a sensible filename (e.g. main.py for Python, index.html for HTML, script.js for JavaScript) and emit the write_to_file tool call with the complete code as the content parameter. Reply to the user in their language AFTER the tool call.`;
          } else if (isAsking) {
            enforcementMsg = `CRITICAL ERROR: You asked a clarifying question, but you must NOT ask questions for routine requests. The system has forced tool_choice=required — you MUST emit a tool call now. If the user said "write code", write a useful utility (task manager, calculator, file organizer). If they said "create a file", create a Python file. Pick a sensible default and emit the write_to_file tool call with complete code. Reply to the user in their language AFTER the tool call.`;
          } else {
            enforcementMsg = ENFORCEMENT_RETRY_PROMPT(language) + '\n\nThe system has forced tool_choice=required. You MUST emit a tool call — text-only responses will be rejected.';
          }

          messages.push({
            role: 'assistant',
            content: response.content || null,
          });
          messages.push({
            role: 'user',
            content: enforcementMsg,
          });
          forceToolRetry = true;
          continue;
        }
        forceToolRetry = false;
        enforcementRetries = 0;

        // Push the assistant message. NOTE: we deliberately do NOT attach
        // structured `tool_calls` here. Tool results are fed back as
        // `role:'user'` Hermes/XML text (see formatToolResult), and strict
        // OpenAI-compatible endpoints reject an assistant message that has
        // `tool_calls` but is not followed by matching `role:'tool'` result
        // messages ("must be followed by tool messages…") — which would make
        // every subsequent API call of this run fail with a 400. Keeping the
        // wire format pure text is consistent with not passing `tools` on
        // normal calls.
        const assistantMsg = {
          role: 'assistant' as const,
          content: response.content || null,
        } as ChatCompletionMessageParam;
        messages.push(assistantMsg);

        if (nonModeSwitchCalls.length === 0) {
          // If tools are blocked and the model produced a text-only response
          // (asking the user what to do), stop the loop — don't keep calling
          // the API.
          if (allToolsBlocked) {
            shouldStop = true;
          }
          break;
        }

        // If tools are blocked but the model STILL tried to call a tool,
        // block it and stop after this iteration.
        if (allToolsBlocked) {
          shouldStop = true;
        }

        // Execute each parsed tool call (sequentially for predictability)
        for (const call of nonModeSwitchCalls) {
          if (this.abortController.signal.aborted) break;

          // Meta tools — no approval needed, no destructive side effects
          if (call.name === 'update_todos') {
            // FIX (e.filter crash): the model sometimes sends `todos` as an
            // object or a JSON string instead of an array. Forwarding that
            // raw value poisoned the webview store and crashed TodoList
            // ("e.filter is not a function"). Only real arrays pass through.
            const todos: TodoItem[] = Array.isArray(call.args?.todos)
              ? (call.args.todos as TodoItem[])
              : [];
            this.deps.callbacks.onTodosUpdate(todos);
            const result = await this.deps.registry.execute(call.name, call.args, ctx);
            const toolMsg: ChatMessage = {
              id: cryptoRandom(),
              role: 'tool',
              content: result.output,
              ts: Date.now(),
              toolName: call.name,
              toolArgs: call.args,
              toolResult: result.output,
              approvalState: 'auto-approved',
              pending: false,
            };
            this.deps.callbacks.onToolEnd(toolMsg);
            messages.push({
              role: 'user',
              content: this.formatToolResult(call.name, result.output, hermesMode),
            });
            continue;
          }

          if (call.name === 'think') {
            // The think tool is a no-op executor; just acknowledge it.
            const result = await this.deps.registry.execute(call.name, call.args, ctx);
            const toolMsg: ChatMessage = {
              id: cryptoRandom(),
              role: 'tool',
              content: result.output,
              ts: Date.now(),
              toolName: call.name,
              toolArgs: call.args,
              toolResult: result.output,
              approvalState: 'auto-approved',
              pending: false,
            };
            this.deps.callbacks.onToolEnd(toolMsg);
            messages.push({
              role: 'user',
              content: this.formatToolResult(call.name, result.output, hermesMode),
            });
            continue;
          }

          // Other tools — require approval based on tool definition and autoApproveMode
          const tool = this.deps.registry.get(call.name);
          const needsApproval =
            this.deps.autoApproveMode === 'none'
              ? true  // 'none' mode: ALL tools require approval
              : tool?.definition.requiresApproval &&
                this.deps.autoApproveMode !== 'all' &&
                !(tool.definition.readOnly && this.deps.autoApproveMode === 'read-only');

          // ── BLOCK all tools after ANY rejection ───────────────────────
          // If the user rejected ANY tool earlier in this run, block ALL
          // subsequent tool calls (not just file writes). This prevents the
          // model from retrying with a different tool or filename after a
          // rejection. The block persists until the user sends a new message.
          if (allToolsBlocked) {
            const blockMsg: ChatMessage = {
              id: cryptoRandom(),
              role: 'tool',
              content: '',
              ts: Date.now(),
              toolName: call.name,
              toolArgs: call.args,
              approvalState: 'rejected',
              pending: false,
            };
            blockMsg.content = `BLOCKED: The user rejected your previous ${blockedToolName} operation. Do NOT attempt ANY tool call (including different tools or filenames). The system has BLOCKED all tool calls for the rest of this turn. Instead, briefly ask the user — in the same language they are writing in — what they would like you to do next.`;
            blockMsg.toolResult = blockMsg.content;
            this.deps.callbacks.onToolStart(blockMsg);
            this.deps.callbacks.onToolEnd(blockMsg);
            messages.push({
              role: 'user',
              content: this.formatToolResult(call.name, blockMsg.content, hermesMode),
            });
            // Break out of the tool-call loop — don't process any more calls
            // in this response.
            break;
          }

          const callId = cryptoRandom();
          const toolMsg: ChatMessage = {
            id: callId,
            role: 'tool',
            content: '',
            ts: Date.now(),
            toolCallId: callId,
            toolName: call.name,
            toolArgs: call.args,
            approvalState: 'pending',
            pending: true,
          };

          // CRITICAL FIX (bug I — infinite rewrite loop):
          // Detect if the model is trying to write the SAME file with the SAME
          // content as a previous successful write in this run. If so, skip
          // the write and return a "already done" result instead of re-writing.
          // This breaks the infinite loop where the model re-emits the same
          // write_to_file call after seeing a truncated tool result.
          if (
            (call.name === 'write_to_file' || call.name === 'append_to_file') &&
            typeof call.args.path === 'string' &&
            typeof call.args.content === 'string'
          ) {
            const filePath = String(call.args.path);
            const content = String(call.args.content);
            const prev = writtenFiles.get(filePath);
            if (prev && prev.content === content && prev.toolName === call.name) {
              // Same file, same content, same tool — this is a duplicate write.
              // Return a "already done" result without re-writing.
              toolMsg.pending = false;
              toolMsg.content = `File already written: ${filePath} (${content.length} characters). No changes needed.`;
              toolMsg.toolResult = toolMsg.content;
              toolMsg.approvalState = 'auto-approved';
              this.deps.callbacks.onToolEnd(toolMsg);
              messages.push({
                role: 'user',
                content: this.formatToolResult(call.name, toolMsg.content, hermesMode),
              });
              continue;
            }
          }

          // CRITICAL FIX (bug K — phantom writes with missing args):
          // Validate that file-writing tools have the required args.
          // The model sometimes emits a write_to_file call with missing or
          // empty path/content. Reject these early with a clear error instead
          // of trying to write to a garbage path.
          if (
            call.name === 'write_to_file' ||
            call.name === 'append_to_file'
          ) {
            const pathArg = call.args.path;
            const contentArg = call.args.content;
            if (typeof pathArg !== 'string' || pathArg.length === 0) {
              toolMsg.pending = false;
              toolMsg.approvalState = 'error';
              toolMsg.content = `Error: ${call.name} requires a non-empty "path" parameter. Please provide a valid file path.`;
              toolMsg.toolResult = toolMsg.content;
              toolMsg.error = 'خطا';
              this.deps.callbacks.onToolEnd(toolMsg);
              messages.push({
                role: 'user',
                content: this.formatToolResult(call.name, toolMsg.content, hermesMode),
              });
              continue;
            }
            if (typeof contentArg !== 'string' || contentArg.length === 0) {
              toolMsg.pending = false;
              toolMsg.approvalState = 'error';
              toolMsg.content = `Error: ${call.name} requires a non-empty "content" parameter.`;
              toolMsg.toolResult = toolMsg.content;
              toolMsg.error = 'خطا';
              this.deps.callbacks.onToolEnd(toolMsg);
              messages.push({
                role: 'user',
                content: this.formatToolResult(call.name, toolMsg.content, hermesMode),
              });
              continue;
            }
          }

          // ── PREVIEW FLOW for file-writing tools ──────────────────────
          // For write_to_file, replace_in_file, insert_at_line, delete_lines,
          // append_to_file: open the OFFICIAL VS Code DIFF EDITOR (original
          // vs incoming) BEFORE asking for approval. The user can review the
          // red/green diff while deciding. Nothing is written to disk until
          // the user approves.
          let previewHandle: PreviewHandle | null = null;
          const isPreviewTool = PREVIEW_TOOLS.has(call.name);

          // Kilo-style "+added -removed" chip: compute the before/after ONCE
          // pre-execution (disk still holds the original here), attach the
          // stats to the tool message, and hand the full diff to the provider
          // so the chat card can re-open the diff editor later.
          if (FILE_MUTATING_TOOLS.has(call.name) && typeof call.args.path === 'string' && call.args.path) {
            try {
              const d = await computeFileEditDiff(call.name, call.args, ctx.workspaceRoot);
              toolMsg.diffStats = countDiffStats(d.before, d.after);
              this.deps.callbacks.onToolDiffData?.(toolMsg.id, d.path, d.before, d.after);
            } catch (diffErr) {
              console.error('[fibonacci-agent] Tool diff stats failed:', diffErr);
            }
          }

          // Check if the live coder already opened the diff editor during streaming.
          const liveState = liveCoder.getFinalState();

          if (isPreviewTool && needsApproval) {
            // Show the tool block as "previewing" in the chat UI.
            this.deps.callbacks.onToolStart(toolMsg);

            if (liveState && liveState.toolName === call.name && liveState.content.length > 0) {
              // The live coder already opened the OFFICIAL diff editor and
              // streamed the content into it in real-time. Reuse that open
              // diff — don't open a second one.
              // Only use it if content was actually streamed (non-empty).
              //
              // CRITICAL FIX (bug G — content truncation):
              // The live coder's `liveState.content` is what was ACTUALLY
              // streamed into the diff. But the streaming can be incomplete
              // if the API connection dropped or chunks were lost. The
              // authoritative content is in `call.args.content` (for
              // write_to_file) or derived from `call.args` (for other tools).
              //
              // We compare the live coder's content to the expected content
              // from the tool call args. If they don't match, we use the
              // tool call args as the source of truth and push the full
              // content back into the live diff via setFinal().
              let expectedContent = liveState.content;
              if (call.name === 'write_to_file' && typeof call.args.content === 'string') {
                expectedContent = call.args.content;
              } else if (call.name === 'append_to_file' && typeof call.args.content === 'string') {
                // For append, the expected content is original + appended.
                // The live coder streamed the appended part; the full file
                // content will be resolved by previewToolCall if needed.
                // Use liveState.content here and let commitPreview verify.
                expectedContent = liveState.content;
              }

              // If the live coder's content is shorter than the expected
              // content, the stream was truncated. Log a warning and use
              // the expected (full) content.
              if (
                call.name === 'write_to_file' &&
                typeof call.args.content === 'string' &&
                liveState.content.length < call.args.content.length
              ) {
                console.warn(
                  `[fibonacci-agent] Live coder streamed ${liveState.content.length} chars ` +
                  `but tool call has ${call.args.content.length} chars. ` +
                  `The stream was truncated — using the full content from the tool call.`
                );
              }

              // Sync the authoritative content into the diff's right side so
              // the user always reviews/approves the FULL intended content.
              liveState.setFinal(expectedContent);

              previewHandle = {
                path: liveState.filePath,
                absPath: liveState.absPath,
                originalContent: liveState.originalContent,
                existed: liveState.existed,
                finalContent: expectedContent,
                diffUris: liveState.uris,
              };
            } else {
              // Live coder didn't fire, or fired but content is empty.
              // Close the live diff if it shows an empty-vs-empty new file.
              if (liveState && liveState.content.length === 0) {
                await liveCoder.cleanupEmptyFile().catch((cleanupErr) => {
                  console.error('[fibonacci-agent] Failed to cleanup empty file during preview fallback:', cleanupErr);
                });
              }

              // Fall back to opening the diff editor now (predicted before vs
              // after — mirrors the real executors, touches nothing on disk).
              try {
                previewHandle = await previewToolCall(call.name, call.args, ctx.signal, ctx.workspaceRoot);
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                const helpfulMsg = `Preview failed: ${errMsg}\n\nThe workspace root is: ${ctx.workspaceRoot}. Use RELATIVE paths (e.g. "main.py", "src/index.html") — do NOT use absolute paths into system directories.`;
                toolMsg.pending = false;
                toolMsg.approvalState = 'error';
                toolMsg.content = helpfulMsg;
                toolMsg.toolResult = helpfulMsg;
                toolMsg.error = 'خطا';
                this.deps.callbacks.onToolEnd(toolMsg);
                messages.push({
                  role: 'user',
                  content: this.formatToolResult(call.name, helpfulMsg, hermesMode),
                });
                continue;
              }
            }
          }

          if (needsApproval) {
            // Race the approval request against the abort signal to prevent
            // the agent loop from hanging if the user closes VS Code or the
            // webview while an approval dialog is pending.
            const approval = await Promise.race([
              this.deps.approvals.requestApproval({
                toolName: call.name,
                args: call.args,
                description: describeToolCall(call.name, call.args),
              }),
              new Promise<ApprovalResponse>((resolve) => {
                this.abortController?.signal.addEventListener(
                  'abort',
                  () => resolve({ id: '', approved: false, reason: 'cancelled' }),
                  { once: true }
                );
              }),
            ]);
            if (!approval.approved) {
              // Revert the preview if one was shown.
              if (previewHandle) {
                await revertPreview(previewHandle).catch((revertErr) => {
                  console.error('[fibonacci-agent] Failed to revert preview after rejection:', revertErr);
                });
              }
              toolMsg.approvalState = 'rejected';
              toolMsg.pending = false;

              // CRITICAL: After ANY rejection, block ALL subsequent tool calls
              // for the rest of this run. This prevents the model from retrying
              // with a different tool or filename.
              allToolsBlocked = true;
              blockedToolName = call.name;

              // Build a tool-specific rejection message.
              const toolDescription = describeToolCall(call.name, call.args);
              toolMsg.content = `The user rejected this operation (${toolDescription}).${approval.reason ? ` Reason: ${approval.reason}` : ''} Do NOT attempt ANY tool call (including different tools or filenames). The system has BLOCKED all tool calls for the rest of this turn. Instead, briefly ask the user — in the same language they are writing in — what they would like you to do next.`;
              toolMsg.toolResult = toolMsg.content;
              if (!isPreviewTool) {
                this.deps.callbacks.onToolStart(toolMsg);
              }
              this.deps.callbacks.onToolEnd(toolMsg);
              messages.push({
                role: 'user',
                content: this.formatToolResult(call.name, toolMsg.content, hermesMode),
              });
              // Break out of the tool-call loop — don't process any more
              // tool calls in this response.
              break;
            }
            toolMsg.approvalState = approval.id === '' ? 'auto-approved' : 'approved';
          }

          if (!isPreviewTool || !needsApproval) {
            this.deps.callbacks.onToolStart(toolMsg);
          }

          // ── COMMIT or EXECUTE ────────────────────────────────────────────
          let result;
          if (previewHandle) {
            // Commit the preview: save the document to disk.
            try {
              // Coverage for the preview path (the registry beforeTool hook
              // only fires on registry.execute()): snapshot checkpoints
              // BEFORE the commit lands on disk.
              if (this.deps.callbacks.beforePreviewCommit) {
                try {
                  await this.deps.callbacks.beforePreviewCommit(call.name, call.args);
                } catch (hookErr) {
                  console.error('[fibonacci-agent] beforePreviewCommit hook failed:', hookErr);
                }
              }
              await commitPreview(previewHandle);
              // Build a result message similar to the tool executor's output.
              const filePath = previewHandle.absPath;
              const charCount = previewHandle.finalContent.length;
              const lineCount = previewHandle.finalContent.split('\n').length;
              result = {
                ok: true,
                output: `File saved: ${filePath} (${charCount} characters, ${lineCount} lines). The before/after diff was shown in the diff editor.`,
              };
              // Coverage for the preview path: auto-diagnostics AFTER the
              // commit (same "\n\n" prefix convention as the registry
              // afterTool hook). Appended to the output before the tool
              // message is emitted, so content, toolResult and the Hermes
              // feedback block all carry it.
              if (this.deps.callbacks.afterPreviewCommit) {
                try {
                  const extra = await this.deps.callbacks.afterPreviewCommit(call.name, call.args);
                  if (extra) {
                    result.output = result.output + '\n\n' + extra;
                  }
                } catch (hookErr) {
                  console.error('[fibonacci-agent] afterPreviewCommit hook failed:', hookErr);
                }
              }

              // CRITICAL FIX (bug I): Record this successful write so we can
              // detect duplicate writes in future iterations and break the
              // infinite rewrite loop.
              if (
                (call.name === 'write_to_file' || call.name === 'append_to_file') &&
                typeof call.args.path === 'string'
              ) {
                writtenFiles.set(String(call.args.path), {
                  content: previewHandle.finalContent,
                  toolName: call.name,
                });
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              // Try to revert on commit failure.
              await revertPreview(previewHandle).catch((revertErr) => {
                console.error('[fibonacci-agent] Failed to revert preview after commit failure:', revertErr);
              });
              result = { ok: false, output: `Save failed: ${errMsg}` };
            }
          } else {
            // Non-preview tool: execute normally.
            result = await this.deps.registry.execute(call.name, call.args, ctx);

            // CRITICAL FIX (bug I — infinite rewrite loop):
            // Track successful non-preview writes so duplicate detection works
            // across iterations. This catches the case where write_to_file runs
            // without preview (e.g., when auto-approved or no approval needed).
            if (
              result.ok &&
              (call.name === 'write_to_file' || call.name === 'append_to_file') &&
              typeof call.args.path === 'string' &&
              typeof call.args.content === 'string'
            ) {
              writtenFiles.set(String(call.args.path), {
                content: String(call.args.content),
                toolName: call.name,
              });
            }
          }

          toolMsg.pending = false;
          toolMsg.content = result.output;
          toolMsg.toolResult = result.output;
          toolMsg.error = result.ok ? undefined : 'خطا';
          this.deps.callbacks.onToolEnd(toolMsg);
          messages.push({
            role: 'user',
            content: this.formatToolResult(call.name, result.output, hermesMode),
          });
        }

        // After processing all tool calls, clean up the live coder: close the
        // live diff tab (execution is done — the chat card keeps a persistent
        // "open diff" button) and drop any state. Nothing on disk was ever
        // pre-written, so there are no orphaned empty files to delete.
        await liveCoder.cleanupEmptyFile().catch((cleanupErr) => {
          console.error('[fibonacci-agent] Failed to cleanup empty file:', cleanupErr);
        });
        await liveCoder.closeDiffEditor().catch((cleanupErr) => {
          console.error('[fibonacci-agent] Failed to close live diff editor:', cleanupErr);
        });

        // CRITICAL FIX: If the model's response text indicates task completion,
        // stop the loop after this iteration. This prevents the model from
        // generating more tool calls after saying "task completed successfully."
        if (indicatesTaskCompletion(prose)) {
          shouldStop = true;
        }
      }

      return [];
    } catch (err) {
      // CRITICAL FIX (bug #3 & #4 in vscode-app-1783401153690.log, and
      // bug F in vscode-app-1783403753675.log):
      // Defensive handling — never let a thrown error crash the entire
      // extension host. The previous version logged the error and called
      // onError, but if `err` was undefined (e.g. from a `throw undefined`
      // or a Promise.reject(undefined) somewhere in the stack), then
      // `String(err)` would yield "undefined" and the user would see
      // "[Extension Host] undefined" in the log without context.
      //
      // ADDITIONAL FIX (bug F): The OpenAI SDK can throw Error objects
      // where `err.message` is `undefined` (e.g. `new APIError(void 0, ...)`)
      // In that case, `err instanceof Error` is true but `err.message` is
      // undefined. The previous code would set `msg = undefined`, then
      // `msg.includes('aborted')` would throw a TypeError, which would
      // escape the catch block and become an unhandled exception → logged
      // as `[Extension Host] undefined`.
      //
      // The fix: use `String(err?.message ?? '')` to guarantee `msg` is
      // always a string, even if `err.message` is undefined/null.
      let msg: string;
      if (err instanceof Error) {
        // err.message can be undefined for OpenAI SDK errors constructed
        // with `new APIError(void 0, ...)` — guard against that.
        const rawMsg = err.message;
        msg = (typeof rawMsg === 'string' && rawMsg.length > 0)
          ? rawMsg
          : `Unknown ${err.name || 'Error'} (no message). Check the API endpoint and network connection.`;
      } else if (err != null) {
        msg = String(err);
      } else {
        msg = 'Unknown error (thrown value was undefined/null). This is likely from the OpenAI SDK stream parser encountering an HTML response.';
      }
      console.error('[fibonacci-agent] Agent loop error:', msg, err);
      // Safe to call .includes() now — msg is guaranteed to be a string.
      if (msg.includes('aborted')) return [];
      // Surface the error to the UI so the user sees what happened.
      this.deps.callbacks.onError(msg);
      return [];
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Format a tool result for feeding back to the LLM. In Hermes mode, uses the
   * `<|tool_response>response:name{value:"..."}<tool_response|>` format. In
   * XML mode, uses the legacy `[Tool result for name]\n...` format.
   */
  private formatToolResult(name: string, output: string, hermesMode: boolean): string {
    if (hermesMode) {
      return formatToolResponseBlock(name, output);
    }
    return `[Tool result for ${name}]\n${output}`;
  }

  /**
   * Fallback: when the model repeatedly fails to emit a tool call (after
   * MAX_ENFORCEMENT_RETRIES), directly create a default file so the user gets
   * SOMETHING. This uses the preview-then-commit flow so the file appears in
   * the editor with the live typing effect, and goes through approval.
   *
   * The filename and content are inferred from the user's last message:
   *   - "python" / "پایتون" → main.py with a useful utility
   *   - "html" / "صفحه" → index.html with a landing page
   *   - "javascript" / "js" → script.js with a utility
   *   - default → main.py with a useful utility
   */
  private async createFallbackFile(
    history: ChatMessage[],
    ctx: ToolContext,
    language: 'fa' | 'en'
  ): Promise<{ ok: boolean; output: string }> {
    const { filename, content } = buildFallbackFile(history, language);
    const isFa = language === 'fa';

    // Use the preview-then-commit flow so the file appears in the editor.
    // The user MUST approve before the file is saved to disk.
    try {
      // Show a tool block in the chat UI as "pending".
      const toolMsg: ChatMessage = {
        id: cryptoRandom(),
        role: 'tool',
        content: '',
        ts: Date.now(),
        toolName: 'write_to_file',
        toolArgs: { path: filename, content },
        approvalState: 'pending',
        pending: true,
      };
      this.deps.callbacks.onToolStart(toolMsg);

      // Open the editor and show the content (with live typing).
      const handle = await previewToolCall('write_to_file', { path: filename, content }, ctx.signal, ctx.workspaceRoot);

      // Ask the user for approval. The user sees the code in the editor
      // while the approval dialog is shown.
      const approval = await this.deps.approvals.requestApproval({
        toolName: 'write_to_file',
        args: { path: filename, content },
        description: isFa
          ? `نوشتن فایل: ${filename} (${content.length} کاراکتر) — کد در ویرایشگر نمایش داده شد`
          : `Write file: ${filename} (${content.length} chars) — code shown in editor`,
      });

      if (!approval.approved) {
        // Revert the preview — restore original state.
        await revertPreview(handle).catch((revertErr) => {
          console.error('[fibonacci-agent] Failed to revert preview during mode switch:', revertErr);
        });
        toolMsg.approvalState = 'rejected';
        toolMsg.pending = false;
        toolMsg.content = isFa
          ? `The user rejected this operation.${approval.reason ? ` Reason: ${approval.reason}` : ''}`
          : `The user rejected this operation.${approval.reason ? ` Reason: ${approval.reason}` : ''}`;
        toolMsg.toolResult = toolMsg.content;
        this.deps.callbacks.onToolEnd(toolMsg);
        return {
          ok: false,
          output: isFa
            ? `The user rejected the fallback file creation.`
            : `The user rejected the fallback file creation.`,
        };
      }

      // Approved — commit (save to disk).
      toolMsg.approvalState = 'approved';
      // Coverage for the preview path (registry hooks don't fire here):
      // checkpoint BEFORE, auto-diagnostics AFTER — same as the main loop.
      if (this.deps.callbacks.beforePreviewCommit) {
        try {
          await this.deps.callbacks.beforePreviewCommit('write_to_file', { path: filename, content });
        } catch (hookErr) {
          console.error('[fibonacci-agent] beforePreviewCommit hook failed:', hookErr);
        }
      }
      await commitPreview(handle);

      const charCount = content.length;
      const lineCount = content.split('\n').length;
      let savedOutput = isFa
        ? `فایل ذخیره شد: ${filename} (${charCount} کاراکتر، ${lineCount} خط). فایل در ویرایشگر باز است.`
        : `File saved: ${filename} (${charCount} characters, ${lineCount} lines). The file is open in the editor.`;
      if (this.deps.callbacks.afterPreviewCommit) {
        try {
          const extra = await this.deps.callbacks.afterPreviewCommit('write_to_file', { path: filename, content });
          if (extra) {
            savedOutput = savedOutput + '\n\n' + extra;
          }
        } catch (hookErr) {
          console.error('[fibonacci-agent] afterPreviewCommit hook failed:', hookErr);
        }
      }
      toolMsg.pending = false;
      toolMsg.content = savedOutput;
      toolMsg.toolResult = toolMsg.content;
      this.deps.callbacks.onToolEnd(toolMsg);

      return {
        ok: true,
        output: savedOutput,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: isFa ? `ساخت فایل پیش‌فرض شکست خورد: ${errMsg}` : `Fallback file creation failed: ${errMsg}` };
    }
  }

  private toOpenAIMessage(m: ChatMessage, hermesMode: boolean): ChatCompletionMessageParam {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: this.formatToolResult(m.toolName ?? 'unknown', m.content || m.toolResult || '(no output)', hermesMode),
      };
    }
    if (m.role === 'user') {
      // Vision input: user messages carrying sanitized image data URLs are
      // sent as multipart content (text part first, then image_url parts).
      // Text-only messages keep the plain-string form — Hermes formatting
      // and wire behavior are unchanged for them.
      if (Array.isArray(m.images) && m.images.length > 0) {
        return {
          role: 'user' as const,
          content: [
            { type: 'text', text: m.content },
            ...m.images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        } as ChatCompletionMessageParam;
      }
      return { role: 'user' as const, content: m.content };
    }
    if (m.role === 'assistant') {
      return { role: 'assistant' as const, content: m.content || null };
    }
    return { role: 'system' as const, content: m.content };
  }
}

function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Project rules (.fibonaccirules) ──────────────────────────────────────────

/** Cap the rules text so a huge file can't blow up the system prompt. */
const MAX_RULES_CHARS = 12_000;

/**
 * module-level cache keyed by absolute path, validated by "path:mtimeMs" so
 * edits to the rules file are picked up without an extension restart.
 */
const rulesCache = new Map<string, { key: string; text: string }>();

/**
 * Read the project rules file for the workspace. First existing candidate
 * wins: `.fibonaccirules.md` → `.fibonaccirules` → `.fibonacci/rules.md`.
 * Non-fatal on any error (returns '').
 */
export function loadRules(workspaceRoot: string): string {
  const candidates = ['.fibonaccirules.md', '.fibonaccirules', '.fibonacci/rules.md'];
  for (const rel of candidates) {
    let abs: string;
    try {
      abs = nodePath.resolve(workspaceRoot, rel);
    } catch {
      continue;
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const key = `${abs}:${st.mtimeMs}`;
      const cached = rulesCache.get(abs);
      if (cached && cached.key === key) return cached.text;
      let text = fs.readFileSync(abs, 'utf-8');
      if (text.length > MAX_RULES_CHARS) {
        text = text.slice(0, MAX_RULES_CHARS) + '\n…[rules truncated]';
      }
      rulesCache.set(abs, { key, text });
      return text;
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return '';
}

function containsCodeBlock(text: string): boolean {
  if (!text) return false;
  const matches = text.match(/```[a-zA-Z0-9_-]*\n[\s\S]+?```/g);
  return !!matches && matches.length > 0;
}

/**
 * Detect if the model's response indicates task completion.
 * The model should STOP after saying the task is done, not continue
 * generating more tool calls.
 */
function indicatesTaskCompletion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const completionPhrases = [
    // Persian
    'عملیات با موفقیت انجام شد',
    'کار تمام شد',
    'انجام شد',
    'تمام شد',
    'آیا کار دیگری هست',
    'چیزی دیگر هست',
    'می‌توانم کمکتان کنم',
    'دیجی کار دیگری',
    'سوال دیگری',
    'دستور دیگری',
    // English
    'operation completed',
    'task completed',
    'completed successfully',
    'is there anything else',
    'anything else i can help',
    'anything else you need',
    'let me know if you need',
    'happy to help',
    'all done',
    'done!',
    'finished',
  ];
  return completionPhrases.some((p) => lower.includes(p));
}

/**
 * Detect "hallucinated completion" — the model SAYS a file was created/made/
 * written/saved but did NOT actually emit a tool call. This is a common
 * failure mode where the model claims success without acting.
 *
 * Persian phrases we catch:
 *   - ساخته شد / ساخته‌شد  (was created/built)
 *   - ایجاد شد / ایجاد‌شد   (was created)
 *   - نوشته شد / نوشته‌شد  (was written)
 *   - ذخیره شد / ذخیره‌شد  (was saved)
 *   - ویرایش شد / ویرایش‌شد (was edited)
 *   - ساختم / ایجاد کردم / نوشتم / ذخیره کردم (I created/built/wrote/saved)
 *
 * English phrases:
 *   - "file created", "file written", "file saved", "file edited"
 *   - "I created", "I wrote", "I saved", "I edited"
 */
function hallucinatedFileCompletion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Persian past-tense completion phrases
  const persianPhrases = [
    'ساخته شد', 'ساخته‌شد', 'ساختم', 'ساخت',
    'ایجاد شد', 'ایجاد‌شد', 'ایجاد کردم', 'ایجاد شد.',
    'نوشته شد', 'نوشته‌شد', 'نوشتم', 'نوشته.',
    'ذخیره شد', 'ذخیره‌شد', 'ذخیره کردم', 'ذخیره شد.',
    'ویرایش شد', 'ویرایش‌شد', 'ویرایش کردم', 'ویرایش شد.',
    'فایل ساخته', 'فایل ایجاد', 'فایل نوشته', 'فایل ذخیره',
    'کد ساخته', 'کد ایجاد', 'کد نوشته', 'کد ذخیره',
  ];
  // English completion phrases
  const englishPhrases = [
    'file created', 'file written', 'file saved', 'file edited',
    'file has been created', 'file has been written', 'file has been saved',
    'file was created', 'file was written', 'file was saved', 'file was edited',
    'file is created', 'file is written', 'file is saved',
    'i created the file', 'i wrote the file', 'i saved the file', 'i edited the file',
    'i created a', 'i wrote a', 'i made a',
    'the file was created', 'the file was written', 'the file was saved',
  ];
  return (
    persianPhrases.some((p) => text.includes(p)) ||
    englishPhrases.some((p) => lower.includes(p))
  );
}

/**
 * Detect when the model is asking a clarifying question for a routine request
 * instead of just acting. The system prompt says <act_dont_ask>, but some
 * models still ask "what should the code do?" when the user says "write code".
 *
 * We catch:
 *   - Persian question phrases: "بگویید", "بفرمایید", "چه کاری", "چه چیزی",
 *     "لطفاً بگویید", "منتظر راهنمایی", "اگر ایده خاصی"
 *   - English: "what should", "please tell", "please specify", "what would you like"
 *   - Question marks in a response that has NO tool calls
 */
function askingClarifyingQuestion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const persianPhrases = [
    'بگویید', 'بفرمایید', 'چه کاری', 'چه چیزی', 'چه نوع',
    'لطفاً بگویید', 'لطفا بگویید', 'منتظر راهنمایی',
    'اگر ایده خاصی', 'اگر ایده‌ خاصی', 'اگر ایده‌ای',
    'می‌خواهید چه', 'میخواهید چه', 'دوست دارید چه',
    'مشخص کنید', 'توضیح دهید', 'راهنمایی کنید',
  ];
  const englishPhrases = [
    'what should', 'what would you like', 'please tell', 'please specify',
    'please describe', 'could you specify', 'what kind of',
    'what do you want', 'i need more information', 'please provide more',
  ];
  return (
    persianPhrases.some((p) => text.includes(p)) ||
    englishPhrases.some((p) => lower.includes(p))
  );
}

function userMessageLooksLikeFileRequest(history: ChatMessage[]): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const originalText = lastUser.content;
  const text = originalText.toLowerCase();

  // Question patterns — explicitly exclude questions first, since users asking
  // about code conventionally mention programming languages without wanting
  // the agent to create files.
  const questionPatterns = [
    // English question words
    /^(how|what|why|when|where|which|who|can|could|would|should|is|are|do|does|did|tell me|explain)\b/i,
    /\?$/,  // ends with question mark
    // Persian question words
    /(چگونه|چطور|چطوری|چرا|کجا|کدام|چه|آیا|می‌توان|میتوان|کی|توضیح|چطور\b|چگونه\b)/,
  ];
  if (questionPatterns.some((p) => p.test(originalText))) {
    return false;
  }

  // Action verbs indicating CREATE/WRITE intent.
  const actionVerbs = [
    // English
    'create', 'make', 'build', 'write', 'generate', 'produce', 'craft',
    // Persian verbs — creation
    'بساز', 'ساخت', 'ساز', 'ایجاد', 'بنویس', 'تولید', 'درست کن',
    // Persian verbs — modification
    'ذخیره', 'ویرایش', 'تغییر', 'اصلاح', 'به‌روز', 'آپدیت',
  ];

  const hasActionVerb = actionVerbs.some((v) => text.includes(v));
  if (!hasActionVerb) return false;

  // Strong imperatives — short clear commands always count.
  // Examples: "create index.html", "make a calculator", "write code"
  const imperativeWithFile = /(?:create|make|build|write|generate|produce|craft|بساز|ایجاد|بنویس|تولید)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:simple\s+)?([a-z][\w-]*\.(?:html|js|ts|py|json|css|md|txt|jsx|tsx|vue|svelte))/i.test(originalText);
  if (imperativeWithFile) return true;

  const imperativeWithObject = /(?:create|make|build|write|generate|produce|craft|بساز|ایجاد|بنویس|تولید)\b/.test(text);
  if (imperativeWithObject && /(file|project|page|code|script|app|website|component|function|class|program|för|فایل|پروژه|صفحه|کد|اسکریپت|برنامه|اپلیکیشن|سایت|کامپوننت|تابع|کلاس)/.test(text)) {
    return true;
  }

  return false;
}

