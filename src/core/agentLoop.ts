import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as vscode from 'vscode';
import type { AgentMode, ChatMessage, ModeSwitchRequest, TodoItem } from '../types';
import { FibonacciClient } from '../api/fibonacciClient';
import { ToolRegistry, type ToolContext } from './toolRegistry';
import { ApprovalManager, describeToolCall } from './approvalManager';
import { parseToolCalls } from './toolParser';
import { buildSystemPrompt, type ToolFormat, ENFORCEMENT_RETRY_PROMPT, TOOL_RESULT_FORMAT_NOTE } from './systemPrompt';
import { formatToolResponseBlock } from './hermesTemplate';
import { PREVIEW_TOOLS, previewToolCall, commitPreview, revertPreview, type PreviewHandle } from './filePreview';
import { LiveCodeStreamer } from './liveCoder';
import type { SkillsRegistry } from './skillsRegistry';

interface AgentLoopDeps {
  client: FibonacciClient;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  autoApproveReadOnly: boolean;
  skills: SkillsRegistry;
  callbacks: {
    onAssistantStart: () => string;
    onAssistantContent: (id: string, content: string, reasoning?: string) => void;
    onAssistantEnd: (id: string, content: string, reasoning?: string) => void;
    onAssistantRemove: (id: string) => void;
    onToolStart: (msg: ChatMessage) => void;
    onToolEnd: (msg: ChatMessage) => void;
    onTodosUpdate: (todos: TodoItem[]) => void;
    onModeSwitchRequest: (request: ModeSwitchRequest) => Promise<boolean>;
    onError: (err: string) => void;
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
    onModeChanged?: (newMode: AgentMode) => void
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

    // Strip the [PLAN MODE] tag from user messages so the LLM doesn't see it.
    const cleanedHistory = history.map((m) =>
      m.role === 'user'
        ? { ...m, content: m.content.replace(/^\[PLAN MODE\]\s*/, '') }
        : m
    );

    const buildMessages = (): ChatCompletionMessageParam[] => {
      const toolFormat: ToolFormat = hermesMode ? 'hermes' : 'xml';
      const systemPrompt = buildSystemPrompt({
        mode: currentMode,
        toolFormat,
        skills: this.deps.skills.list(),
        workspaceRoot,
        language,
        currentDate: new Date().toISOString().slice(0, 10),
        modelName: model,
        maxIterations,
        enableReasoning: showReasoning,
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
    const openaiTools = this.deps.registry.toOpenAITools();

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
        const toolsParam = forceToolRetry ? openaiTools : undefined;

        const response = await this.deps.client.chat({
          model,
          messages,
          tools: toolsParam,
          toolChoice,
          temperature: 0.3,
          signal: this.abortController.signal,
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
              void liveCoder.processDelta(delta, rawBuffer);
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
              void liveCoder.processOpenAIDelta(toolName, argsFragment, fullArgs);
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

        this.deps.callbacks.onAssistantEnd(assistantId, prose, finalThinking);

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
          nonModeSwitchCalls.length === 0 &&
          looksLikeFileRequest &&
          !allToolsBlocked &&  // Don't enforce if tools are blocked
          (hasCodeBlock || hasPseudoToolCall || hasHallucination || isAsking)
        ) {
          // Remove the hallucinated assistant message from the UI so the
          // user doesn't see duplicate "فایل ساخته شد" bubbles. The message
          // stays in the `messages` array for the API to see the conversation
          // history, but is removed from the visible chat.
          this.deps.callbacks.onAssistantRemove(assistantId);

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
            enforcementMsg = `CRITICAL ERROR: You said "فایل ساخته شد" (file was created) but you did NOT actually emit a tool call. This is a HALLUCINATION. The file was NOT created. You MUST emit the write_to_file tool call NOW. The system has forced tool_choice=required, so the API will ONLY accept a tool call — text responses will be rejected. Pick a sensible filename (e.g. main.py for Python, index.html for HTML, script.js for JavaScript) and emit the write_to_file tool call with the complete code as the content parameter. Reply to the user in Persian AFTER the tool call.`;
          } else if (isAsking) {
            enforcementMsg = `CRITICAL ERROR: You asked a clarifying question, but you must NOT ask questions for routine requests. The system has forced tool_choice=required — you MUST emit a tool call now. If the user said "write code", write a useful utility (task manager, calculator, file organizer). If they said "create a file", create a Python file. Pick a sensible default and emit the write_to_file tool call with complete code. Reply to the user in Persian AFTER the tool call.`;
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

        // Push the assistant message. If the API returned structured
        // tool_calls, include them so the API can correlate tool results.
        const assistantMsg = {
          role: 'assistant' as const,
          content: response.content || null,
          ...(response.toolCalls.length > 0
            ? {
                tool_calls: response.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.args),
                  },
                })),
              }
            : {}),
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
            const todos = (call.args.todos as TodoItem[]) ?? [];
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

          // Other tools — require approval based on tool definition
          const tool = this.deps.registry.get(call.name);
          const needsApproval =
            tool?.definition.requiresApproval &&
            !(tool.definition.readOnly && this.deps.autoApproveReadOnly);

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
            blockMsg.content = `BLOCKED: The user rejected your previous ${blockedToolName} operation. Do NOT attempt ANY tool call (including different tools or filenames). The system has BLOCKED all tool calls for the rest of this turn. Instead, ask the user in Persian what they would like you to do — e.g. "به نظر می‌رسد عملیات مورد تایید شما نبود. چه کاری مایل هستید انجام دهم؟"`;
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

          // ── PREVIEW FLOW for file-writing tools ──────────────────────────
          // For write_to_file, replace_in_file, insert_at_line, delete_lines,
          // append_to_file: open the file in VS Code's editor and show the
          // content BEFORE asking for approval. The user can see the code in
          // the editor while deciding. Nothing is written to disk until the
          // user approves.
          let previewHandle: PreviewHandle | null = null;
          const isPreviewTool = PREVIEW_TOOLS.has(call.name);

          // Check if the live coder already opened the editor during streaming.
          const liveState = liveCoder.getFinalState();

          if (isPreviewTool && needsApproval) {
            // Show the tool block as "previewing" in the chat UI.
            this.deps.callbacks.onToolStart(toolMsg);

            if (liveState && liveState.toolName === call.name && liveState.content.length > 0) {
              // The live coder already opened the editor and streamed the
              // content in real-time. Use that editor — don't re-open.
              // Only use it if content was actually streamed (non-empty).
              //
              // CRITICAL FIX (bug G — content truncation):
              // The live coder's `liveState.content` is what was ACTUALLY
              // streamed into the editor. But the streaming can be incomplete
              // if the API connection dropped or chunks were lost. The
              // authoritative content is in `call.args.content` (for
              // write_to_file) or derived from `call.args` (for other tools).
              //
              // We compare the live coder's content to the expected content
              // from the tool call args. If they don't match, we use the
              // tool call args as the source of truth (the model's full
              // intended content), and commitPreview will force-set the
              // editor to this content before saving.
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

              previewHandle = {
                uri: liveState.editor.document.uri,
                editor: liveState.editor,
                originalContent: liveState.originalContent,
                existed: liveState.existed,
                finalContent: expectedContent,
              };
            } else {
              // Live coder didn't fire, or fired but content is empty.
              // Clean up any empty file the live coder may have created.
              if (liveState && liveState.content.length === 0) {
                await liveCoder.cleanupEmptyFile().catch(() => {});
              }

              // Fall back to opening the editor now and setting the content.
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
            const approval = await this.deps.approvals.requestApproval({
              toolName: call.name,
              args: call.args,
              description: describeToolCall(call.name, call.args),
            });
            if (!approval.approved) {
              // Revert the preview if one was shown.
              if (previewHandle) {
                await revertPreview(previewHandle).catch(() => {});
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
              toolMsg.content = `The user rejected this operation (${toolDescription}).${approval.reason ? ` Reason: ${approval.reason}` : ''} Do NOT attempt ANY tool call (including different tools or filenames). The system has BLOCKED all tool calls for the rest of this turn. Instead, ask the user in Persian what they would like you to do — e.g. "به نظر می‌رسد عملیات مورد تایید شما نبود. چه کاری مایل هستید انجام دهم؟"`;
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
              await commitPreview(previewHandle);
              // Build a result message similar to the tool executor's output.
              const filePath = previewHandle.editor.document.uri.fsPath;
              const charCount = previewHandle.finalContent.length;
              const lineCount = previewHandle.finalContent.split('\n').length;
              result = {
                ok: true,
                output: `File saved: ${filePath} (${charCount} characters, ${lineCount} lines). The file is open in the editor.`,
              };

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
              await revertPreview(previewHandle).catch(() => {});
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

        // After processing all tool calls, clean up any empty files that the
        // live coder may have created but that were never filled with content.
        // This prevents orphaned empty files from accumulating on disk.
        await liveCoder.cleanupEmptyFile().catch(() => {});

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
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const userText = (lastUser?.content ?? '').toLowerCase();
    const isFa = language === 'fa';

    let filename: string;
    let content: string;

    if (userText.includes('html') || userText.includes('صفحه') || userText.includes('landing') || userText.includes('سایت')) {
      filename = 'index.html';
      content = isFa
        ? `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>صفحه فرود</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Vazirmatn', sans-serif; background: #1a1a2e; color: #fff; }
    .hero { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2rem; }
    .hero h1 { font-size: 3rem; margin-bottom: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: 1.2rem; color: #aaa; margin-bottom: 2rem; max-width: 600px; }
    .cta { padding: 1rem 2rem; background: #FE03C3; color: #fff; border: none; border-radius: 8px; font-size: 1.1rem; cursor: pointer; transition: transform 0.2s; }
    .cta:hover { transform: translateY(-2px); }
  </style>
</head>
<body>
  <section class="hero">
    <h1>به صفحه ما خوش آمدید</h1>
    <p>یک صفحه فرود ساده و زیبا با HTML و CSS. این صفحه توسط Fibonacci Agent ساخته شده است.</p>
    <button class="cta" onclick="alert('سلام!')">شروع کنید</button>
  </section>
</body>
</html>`
        : `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Landing Page</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #fff; }
    .hero { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 2rem; }
    .hero h1 { font-size: 3rem; margin-bottom: 1rem; background: linear-gradient(135deg, #FE03C3, #3794ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .hero p { font-size: 1.2rem; color: #aaa; margin-bottom: 2rem; max-width: 600px; }
    .cta { padding: 1rem 2rem; background: #FE03C3; color: #fff; border: none; border-radius: 8px; font-size: 1.1rem; cursor: pointer; transition: transform 0.2s; }
    .cta:hover { transform: translateY(-2px); }
  </style>
</head>
<body>
  <section class="hero">
    <h1>Welcome to Our Page</h1>
    <p>A simple and beautiful landing page with HTML and CSS. This page was created by Fibonacci Agent.</p>
    <button class="cta" onclick="alert('Hello!')">Get Started</button>
  </section>
</body>
</html>`;
    } else if (userText.includes('javascript') || userText.includes('js') || userText.includes('جاوا اسکریپت') || userText.includes('جاوااسکریپت')) {
      filename = 'script.js';
      content = isFa
        ? `// یک ابزار کاربردی جاوااسکریپت — ماشین حساب ساده
// ساخته شده توسط Fibonacci Agent

class Calculator {
  constructor() {
    this.history = [];
  }

  add(a, b) {
    const result = a + b;
    this.history.push(\`\${a} + \${b} = \${result}\`);
    return result;
  }

  subtract(a, b) {
    const result = a - b;
    this.history.push(\`\${a} - \${b} = \${result}\`);
    return result;
  }

  multiply(a, b) {
    const result = a * b;
    this.history.push(\`\${a} × \${b} = \${result}\`);
    return result;
  }

  divide(a, b) {
    if (b === 0) throw new Error('تقسیم بر صفر مجاز نیست');
    const result = a / b;
    this.history.push(\`\${a} ÷ \${b} = \${result}\`);
    return result;
  }

  getHistory() {
    return this.history;
  }
}

// استفاده
const calc = new Calculator();
console.log('2 + 3 =', calc.add(2, 3));
console.log('10 - 4 =', calc.subtract(10, 4));
console.log('5 × 6 =', calc.multiply(5, 6));
console.log('20 ÷ 4 =', calc.divide(20, 4));
console.log('تاریخچه:', calc.getHistory());
`
        : `// A useful JavaScript utility — Simple Calculator
// Created by Fibonacci Agent

class Calculator {
  constructor() {
    this.history = [];
  }

  add(a, b) {
    const result = a + b;
    this.history.push(\`\${a} + \${b} = \${result}\`);
    return result;
  }

  subtract(a, b) {
    const result = a - b;
    this.history.push(\`\${a} - \${b} = \${result}\`);
    return result;
  }

  multiply(a, b) {
    const result = a * b;
    this.history.push(\`\${a} × \${b} = \${result}\`);
    return result;
  }

  divide(a, b) {
    if (b === 0) throw new Error('Division by zero is not allowed');
    const result = a / b;
    this.history.push(\`\${a} ÷ \${b} = \${result}\`);
    return result;
  }

  getHistory() {
    return this.history;
  }
}

// Usage
const calc = new Calculator();
console.log('2 + 3 =', calc.add(2, 3));
console.log('10 - 4 =', calc.subtract(10, 4));
console.log('5 × 6 =', calc.multiply(5, 6));
console.log('20 ÷ 4 =', calc.divide(20, 4));
console.log('History:', calc.getHistory());
`;
    } else {
      // Default: Python utility
      filename = 'main.py';
      content = isFa
        ? `#!/usr/bin/env python3
"""
یک ابزار کاربردی پایتون — مدیریت لیست کارهای روزانه
ساخته شده توسط Fibonacci Agent
"""

import json
import os
from datetime import datetime
from pathlib import Path


class TaskManager:
    """مدیریت لیست کارهای روزانه با ذخیره‌سازی در فایل JSON."""

    def __init__(self, filepath="tasks.json"):
        self.filepath = Path(filepath)
        self.tasks = self._load()

    def _load(self):
        """بارگذاری کارها از فایل."""
        if self.filepath.exists():
            with open(self.filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        return []

    def _save(self):
        """ذخیره کارها در فایل."""
        with open(self.filepath, "w", encoding="utf-8") as f:
            json.dump(self.tasks, f, ensure_ascii=False, indent=2)

    def add(self, title, priority="normal"):
        """افزودن کار جدید."""
        task = {
            "id": len(self.tasks) + 1,
            "title": title,
            "priority": priority,
            "done": False,
            "created_at": datetime.now().isoformat(),
        }
        self.tasks.append(task)
        self._save()
        return task

    def complete(self, task_id):
        """تکمیل یک کار."""
        for task in self.tasks:
            if task["id"] == task_id:
                task["done"] = True
                task["completed_at"] = datetime.now().isoformat()
                self._save()
                return task
        return None

    def list_tasks(self, show_done=True):
        """نمایش لیست کارها."""
        if show_done:
            return self.tasks
        return [t for t in self.tasks if not t["done"]]

    def remove(self, task_id):
        """حذف یک کار."""
        before = len(self.tasks)
        self.tasks = [t for t in self.tasks if t["id"] != task_id]
        self._save()
        return len(self.tasks) < before

    def summary(self):
        """خلاصه‌ای از کارها."""
        total = len(self.tasks)
        done = sum(1 for t in self.tasks if t["done"])
        pending = total - done
        return {
            "total": total,
            "done": done,
            "pending": pending,
            "progress": f"{(done / total * 100) if total else 0:.1f}%",
        }


def main():
    """تابع اصلی — نمایش قابلیت‌ها."""
    tm = TaskManager()

    # افزودن چند کار نمونه
    tm.add("خرید مواد غذایی", "high")
    tm.add("تمرین ورزش", "normal")
    tm.add("مطالعه کتاب", "low")

    # تکمیل یک کار
    tm.complete(1)

    # نمایش خلاصه
    summary = tm.summary()
    print("=" * 50)
    print("📋  خلاصه کارهای روزانه")
    print("=" * 50)
    print(f"  کل کارها: {summary['total']}")
    print(f"  انجام شده: {summary['done']}")
    print(f"  باقی مانده: {summary['pending']}")
    print(f"  پیشرفت: {summary['progress']}")
    print("=" * 50)

    # نمایش لیست کارها
    print("\\n📝  لیست کارها:")
    for task in tm.list_tasks():
        status = "✅" if task["done"] else "⬜"
        print(f"  {status} [{task['id']}] {task['title']} (اولویت: {task['priority']})")


if __name__ == "__main__":
    main()
`
        : `#!/usr/bin/env python3
"""
A useful Python utility — Daily Task Manager
Created by Fibonacci Agent
"""

import json
import os
from datetime import datetime
from pathlib import Path


class TaskManager:
    """Manage daily tasks with JSON file storage."""

    def __init__(self, filepath="tasks.json"):
        self.filepath = Path(filepath)
        self.tasks = self._load()

    def _load(self):
        """Load tasks from file."""
        if self.filepath.exists():
            with open(self.filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        return []

    def _save(self):
        """Save tasks to file."""
        with open(self.filepath, "w", encoding="utf-8") as f:
            json.dump(self.tasks, f, ensure_ascii=False, indent=2)

    def add(self, title, priority="normal"):
        """Add a new task."""
        task = {
            "id": len(self.tasks) + 1,
            "title": title,
            "priority": priority,
            "done": False,
            "created_at": datetime.now().isoformat(),
        }
        self.tasks.append(task)
        self._save()
        return task

    def complete(self, task_id):
        """Complete a task."""
        for task in self.tasks:
            if task["id"] == task_id:
                task["done"] = True
                task["completed_at"] = datetime.now().isoformat()
                self._save()
                return task
        return None

    def list_tasks(self, show_done=True):
        """List tasks."""
        if show_done:
            return self.tasks
        return [t for t in self.tasks if not t["done"]]

    def remove(self, task_id):
        """Remove a task."""
        before = len(self.tasks)
        self.tasks = [t for t in self.tasks if t["id"] != task_id]
        self._save()
        return len(self.tasks) < before

    def summary(self):
        """Summary of tasks."""
        total = len(self.tasks)
        done = sum(1 for t in self.tasks if t["done"])
        pending = total - done
        return {
            "total": total,
            "done": done,
            "pending": pending,
            "progress": f"{(done / total * 100) if total else 0:.1f}%",
        }


def main():
    """Main function — demo capabilities."""
    tm = TaskManager()

    # Add sample tasks
    tm.add("Buy groceries", "high")
    tm.add("Exercise", "normal")
    tm.add("Read a book", "low")

    # Complete a task
    tm.complete(1)

    # Show summary
    summary = tm.summary()
    print("=" * 50)
    print("📋  Daily Task Summary")
    print("=" * 50)
    print(f"  Total tasks: {summary['total']}")
    print(f"  Completed: {summary['done']}")
    print(f"  Pending: {summary['pending']}")
    print(f"  Progress: {summary['progress']}")
    print("=" * 50)

    # List tasks
    print("\\n📝  Task List:")
    for task in tm.list_tasks():
        status = "✅" if task["done"] else "⬜"
        print(f"  {status} [{task['id']}] {task['title']} (priority: {task['priority']})")


if __name__ == "__main__":
    main();
`;
    }

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
        await revertPreview(handle).catch(() => {});
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
      await commitPreview(handle);

      const charCount = content.length;
      const lineCount = content.split('\n').length;
      toolMsg.pending = false;
      toolMsg.content = isFa
        ? `فایل ذخیره شد: ${filename} (${charCount} کاراکتر، ${lineCount} خط). فایل در ویرایشگر باز است.`
        : `File saved: ${filename} (${charCount} characters, ${lineCount} lines). The file is open in the editor.`;
      toolMsg.toolResult = toolMsg.content;
      this.deps.callbacks.onToolEnd(toolMsg);

      return {
        ok: true,
        output: isFa
          ? `فایل ذخیره شد: ${filename} (${charCount} کاراکتر، ${lineCount} خط). فایل در ویرایشگر باز است.`
          : `File saved: ${filename} (${charCount} characters, ${lineCount} lines). The file is open in the editor.`,
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
  const text = lastUser.content.toLowerCase();
  // Persian keywords — broadened to catch generic "write code" requests
  const keywords = [
    // Persian — creation verbs
    'ساز', 'بساز', 'بنویس', 'ایجاد', 'ذخیره', 'ویرایش', 'تغییر', 'اصلاح',
    // Persian — nouns
    'فایل', 'پروژه', 'صفحه', 'کد', 'اسکریپت', 'کامپوننت', 'تابع', 'کلاس',
    'برنامه', 'اپ', 'اپلیکیشن', 'وب‌سایت', 'سایت', 'داشبورد', 'ابزار',
    // Persian — topics that imply building something
    'مدیریت', 'ماشین حساب', 'بازی', 'داده', 'تحلیل', 'تبدیل', 'پاک',
    // Persian — "write a code" / "make a file"
    'یک کد', 'یک فایل', 'یک برنامه', 'یک اسکریپت', 'یک صفحه', 'یک ابزار',
    'کد پایتون', 'کد جاوا', 'کد جاوااسکریپت', 'کد تایپ',
    'پایتون', 'جاوا اسکریپت', 'جاوااسکریپت', 'تیپ‌اسکریپت', 'تایپ‌اسکریپت',
    // English
    'create', 'make', 'build', 'write', 'generate', 'file', 'html', 'css',
    'javascript', 'js ', 'ts ', 'typescript', 'python', 'json', 'script',
    'component', 'function', 'class', 'project', 'page', 'landing',
    'code', 'app', 'application', 'website', 'dashboard', 'tool', 'utility',
    'manager', 'calculator', 'game', 'analyzer',
  ];
  return keywords.some((kw) => text.includes(kw));
}
