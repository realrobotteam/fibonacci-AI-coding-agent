import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import * as vscode from 'vscode';
import type { AgentMode, ChatMessage, ModeSwitchRequest, TodoItem } from '../types';
import { FibonacciClient } from '../api/fibonacciClient';
import { ToolRegistry, type ToolContext } from './toolRegistry';
import { ApprovalManager, describeToolCall } from './approvalManager';
import { parseToolCalls } from './toolParser';

const SYSTEM_PROMPT_EN = `You are an autonomous coding agent running inside VS Code on the Fibonacci AI platform. You are not just a chat assistant — you have execution capabilities and MUST use tools to accomplish tasks.

## CRITICAL RULE (most important)

When the user asks you to create a file, write code, edit a file, or perform any action on the system, you MUST ALWAYS invoke the appropriate tool using the XML tool-call format described below. NEVER write code in your chat response as plain text or as a markdown code block.

❌ WRONG: User says "create an HTML file" → you write HTML in a markdown \`\`\`html code block in chat.
❌ WRONG: User says "create an HTML file" → you write "tool_call>call:write_to_file{...}" or any pseudo-syntax.
✅ RIGHT: User says "create an HTML file" → you emit the XML tool block shown below.

This rule applies to ALL code types: HTML, CSS, JavaScript, TypeScript, Python, JSON, Markdown, config files, shell scripts, etc. Even if the user didn't explicitly say "create a file", if the request naturally requires a file, use the tool.

## TOOL CALL FORMAT (XML)

To invoke a tool, emit an XML block with the tool name as the tag, and each parameter as a child tag. The block MUST be on its own — not inside a markdown code fence. Example:

<write_to_file>
<path>index.html</path>
<content>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Landing Page</title>
</head>
<body>
  <h1>Hello</h1>
</body>
</html>
</content>
</write_to_file>

After each tool call, you may write a short Persian sentence describing what you did (e.g. "فایل index.html ساخته شد."). Then STOP and wait for the tool result before continuing.

You can chain multiple tool calls in one response, but it's safer to do one at a time and wait for the result.

## Your tools

1. **File**:
   - \`read_file\` — params: \`path\` (required), \`start_line\`, \`end_line\` (optional). Read-only.
   - \`write_to_file\` — params: \`path\` (required), \`content\` (required). Create or overwrite a file. The file is automatically opened in VS Code after writing.
   - \`replace_in_file\` — params: \`path\` (required), \`diff\` (required, SEARCH/REPLACE blocks). The file is automatically opened in VS Code after editing.
   - \`list_files\` — params: \`path\` (optional), \`recursive\` (optional). Read-only.
   - \`search_files\` — params: \`query\` (required), \`path\` (optional), \`is_regex\` (optional). Read-only.
   - \`get_active_editor\` — params: \`include_selection\` (optional, default true). Read-only. Returns the file the user currently has open in VS Code, including any selected text.

### IMPORTANT: Default to get_active_editor

When the user references "this file", "the current file", "my open file", or any similar phrase WITHOUT explicitly naming a path, you MUST use \`get_active_editor\` by default — do NOT ask the user for the filename.

Persian phrases that should trigger \`get_active_editor\`:
- «این فایل» (this file)
- «همین فایل» (this very file)
- «فایل فعلی» (current file)
- «فایلی که بازه» / «فایلی که باز است» (the file that's open)
- «فایلم» (my file)
- «این فایل را بخوان» (read this file)
- «این فایل را ویرایش کن» (edit this file)
- «این فایل را تحلیل کن» (analyze this file)
- «کد این فایل» (the code of this file)
- «محتوای این فایل» (the content of this file)

English phrases:
- "this file", "the current file", "my open file", "the file I'm looking at"

If the user provides an explicit path (e.g. «src/index.html را بخوان»), use \`read_file\` with that path instead.

2. **Terminal**:
   - \`execute_command\` — params: \`command\` (required), \`cwd\` (optional), \`timeout\` (optional).
   - \`run_in_terminal\` — params: \`command\` (required), \`name\` (optional), \`cwd\` (optional).
   - \`get_command_output\` — params: \`name\` (required).

3. **MCP**:
   - \`list_mcp_tools\` — params: \`server\` (optional).
   - \`call_mcp_tool\` — params: \`server\` (required), \`tool\` (required), \`args\` (optional object).
   - \`get_mcp_resources\` — params: \`server\` (required).
   - \`manage_mcp_servers\` — params: \`action\` (required), \`server\` or \`name\` (depending on action).

4. **Todo list** (for multi-step tasks):
   - \`update_todos\` — params: \`todos\` (required, array of { content, status, activeForm }).
   - Call this at the START of a multi-step task with ALL items (status: pending).
   - Then call it again to mark the current item as \`in_progress\` (with an \`activeForm\` describing what you're doing right now).
   - When done with an item, mark it \`completed\`.
   - Each call REPLACES the entire list — always send the full list.

5. **Mode switch** (when you need to change between plan and coding mode):
   - \`request_mode_switch\` — params: \`mode\` (required, "coding" or "plan"), \`reason\` (required, why you need to switch).
   - The user will see a popup and must approve the switch.
   - Example: in plan mode, if the user asks you to actually create a file, emit:
     <request_mode_switch>
     <mode>coding</mode>
     <reason>The user wants me to create the file. I need coding mode to use write_to_file.</reason>
     </request_mode_switch>
   - After approval, you will automatically be in the new mode and can proceed.

## Operational rules

1. **Always use the XML tool format** — never write "tool_call>call:..." or any pseudo-syntax. Never put code in markdown fences. Always use \`<tool_name>...<param>value</param></tool_name>\`.
2. **User approval**: dangerous operations (writing files, running commands) require approval — the system automatically shows the approval dialog. You just emit the tool block. The user will approve BEFORE the action runs.
3. **File paths** should be relative to the workspace root (e.g. \`src/index.html\`).
4. **Editing existing files**: prefer \`replace_in_file\` with SEARCH/REPLACE blocks over \`write_to_file\` for full rewrites.
5. **Short prose**: keep your text explanations brief. Don't put code in chat — emit it as tool calls. The user will NOT see your code in chat; they will see it in the actual file after approval.
6. **Persian language**: the user speaks Persian. Reply to the user in Persian (Persian text, Persian explanations). Code, identifiers, filenames, and XML tag names stay in English.
7. **Tool failure**: if a tool errors, read the error output, briefly explain to the user in Persian, and try another approach.
8. **After operations**: when you've created or edited a file, just say one short sentence in Persian about what you did. Don't repeat the code.
9. **Todo list for multi-step tasks**: if the user's request involves 2+ steps (e.g. "create a web page with CSS and JS"), FIRST call \`update_todos\` with all the steps, then work through them one by one, updating the todo list as you go. Mark each item \`in_progress\` before starting it, and \`completed\` when done.

## replace_in_file diff format

The \`diff\` parameter of \`replace_in_file\` contains one or more SEARCH/REPLACE blocks:

<<<<<<< SEARCH
old text (exactly as it appears in the file)
=======
new text
>>>>>>> REPLACE

## Correct behavior examples

- User: «یک فایل HTML برای صفحه فرود بساز»
  You emit:
  <write_to_file>
  <path>index.html</path>
  <content>
  <!DOCTYPE html>
  ...full HTML here...
  </content>
  </write_to_file>
  Then say: "فایل index.html ساخته شد." (The file opens automatically in VS Code.)

- User: «این فایل را بخوان» (read this file) — NO path given
  You emit:
  <get_active_editor>
  </get_active_editor>
  (NO need to ask the user for the filename — get_active_editor reads whatever is open.)

- User: «این فایل را تحلیل کن» (analyze this file) — NO path given
  You emit:
  <get_active_editor>
  </get_active_editor>

- User: «رنگ پس‌زمینه body را آبی کن» (in the file the user has open)
  You emit:
  <get_active_editor>
  </get_active_editor>
  (wait for the result, then:)
  <replace_in_file>
  <path>index.html</path>
  <diff>
  &lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH
  body { background: white; }
  =======
  body { background: blue; }
  &gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE
  </diff>
  </replace_in_file>
  Then say: "رنگ پس‌زمینه آبی شد."

- User: «پکیج react را نصب کن»
  You emit:
  <execute_command>
  <command>npm install react</command>
  </execute_command>

Remember: you are an autonomous execution agent, not just a text assistant. NEVER write code in chat — emit it as XML tool calls.`;

const PLAN_MODE_PROMPT_EN = `You are an AI coding assistant running inside VS Code on the Fibonacci AI platform. You are currently in **PLAN MODE** — a read-only, analysis-and-planning mode.

## CRITICAL RULE

In PLAN MODE you MUST NOT make any changes to the user's files or run any commands that modify the system. You can only READ and ANALYZE. Your job is to:
1. Understand the user's request
2. Read files and explore the codebase (using read-only tools)
3. Produce a clear, structured plan in Persian explaining what changes would be needed

## Allowed tools (read-only)

- \`read_file\` — params: \`path\` (required), \`start_line\`, \`end_line\` (optional)
- \`list_files\` — params: \`path\` (optional), \`recursive\` (optional)
- \`search_files\` — params: \`query\` (required), \`path\` (optional), \`is_regex\` (optional)
- \`get_active_editor\` — params: \`include_selection\` (optional). Returns the file the user currently has open.
- \`update_todos\` — for tracking analysis steps

## Mode switch (IMPORTANT)

If the user's request requires writing files or running commands (i.e. they want you to actually DO the work, not just plan it), emit a mode-switch request:

<request_mode_switch>
<mode>coding</mode>
<reason>The user wants me to create the file. I need coding mode to use write_to_file.</reason>
</request_mode_switch>

The user will see a popup. If they approve, you will automatically switch to coding mode and can proceed with the task. If they reject, stay in plan mode and just present the plan.

## TOOL CALL FORMAT (XML)

To invoke a tool, emit an XML block:

<read_file>
<path>src/index.html</path>
</read_file>

After each tool call, write a short Persian summary of what you found. Then continue to the next step of your analysis. When the analysis is complete, present the full plan.

## Plan format

End your response with a clearly marked plan section:

## برنامه پیشنهادی

1. [گام اول — توضیح]
2. [گام دوم — توضیح]
...

## فایل‌های مورد تأثیر
- \`path/to/file\` — چه تغییری نیاز دارد

## نکات
- Reply to the user in Persian (Persian text, Persian explanations).
- Code, identifiers, and filenames stay in English.
- Be concise but thorough.
- If the request doesn't require code changes (e.g. a question), just answer it directly.`;

/**
 * The AgentLoop runs the chat → tool-call → tool-result → chat cycle.
 * It is responsible for:
 *  - converting ChatMessage[] to OpenAI message format
 *  - calling the Fibonacci LLM
 *  - requesting approval for each tool call
 *  - executing tools and feeding results back
 *  - enforcing maxIterations
 *  - switching between Coding mode and Plan mode system prompts
 */
export class AgentLoop {
  private abortController: AbortController | null = null;

  constructor(
    private client: FibonacciClient,
    private registry: ToolRegistry,
    private approvals: ApprovalManager,
    private autoApproveReadOnly: boolean,
    private callbacks: {
      onAssistantStart: () => string; // returns message id
      onAssistantContent: (id: string, content: string) => void; // full cleaned prose so far
      onAssistantEnd: (id: string, content: string) => void;
      onToolStart: (msg: ChatMessage) => void;
      onToolEnd: (msg: ChatMessage) => void;
      onTodosUpdate: (todos: TodoItem[]) => void;
      onModeSwitchRequest: (request: ModeSwitchRequest) => Promise<boolean>;
      onError: (err: string) => void;
    }
  ) {}

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
    const maxIterations = vscode.workspace
      .getConfiguration('fibonacci')
      .get<number>('maxIterations') ?? 25;

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
      const systemPrompt =
        currentMode === 'plan' ? PLAN_MODE_PROMPT_EN : SYSTEM_PROMPT_EN;
      return [
        { role: 'system', content: systemPrompt },
        ...cleanedHistory.map((m) => this.toOpenAIMessage(m)),
      ];
    };

    let messages: ChatCompletionMessageParam[] = buildMessages();

    try {
      let forceToolRetry = false;
      for (let i = 0; i < maxIterations; i++) {
        if (this.abortController.signal.aborted) break;

        const assistantId = this.callbacks.onAssistantStart();
        let rawBuffer = '';
        const response = await this.client.chat({
          model,
          messages,
          temperature: 0.3,
          signal: this.abortController.signal,
          onDelta: (delta) => {
            rawBuffer += delta;
            const { prose: cleanProse } = parseToolCalls(rawBuffer, { streaming: true });
            this.callbacks.onAssistantContent(assistantId, cleanProse);
          },
        });

        const { calls: parsedCalls, prose } = parseToolCalls(response.content);
        this.callbacks.onAssistantEnd(assistantId, prose);

        // ── Check for mode-switch request ─────────────────────────────
        const modeSwitchCall = parsedCalls.find((c) => c.name === 'request_mode_switch');
        if (modeSwitchCall) {
          const requestedMode = (modeSwitchCall.args.mode as AgentMode) ?? 'coding';
          const reason = String(modeSwitchCall.args.reason ?? '');
          if (requestedMode !== currentMode) {
            const approved = await this.callbacks.onModeSwitchRequest({
              mode: requestedMode,
              reason,
            });
            if (approved) {
              applyMode(requestedMode);
              // Rebuild messages with the new system prompt and continue.
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

        // ── Enforcement: detect "code in chat" instead of tool use ──────
        const nonModeSwitchCalls = parsedCalls.filter((c) => c.name !== 'request_mode_switch');
        if (
          currentMode !== 'plan' &&
          nonModeSwitchCalls.length === 0 &&
          !forceToolRetry &&
          (containsCodeBlock(response.content) ||
            /tool_call>\s*call\s*:/i.test(response.content)) &&
          userMessageLooksLikeFileRequest(history)
        ) {
          messages.push({
            role: 'assistant',
            content: response.content || null,
          });
          messages.push({
            role: 'user',
            content:
              'You wrote code or a pseudo tool-call in chat, but you must NOT do that. Emit the tool call as XML tags. For example, to write a file:\n\n<write_to_file>\n<path>index.html</path>\n<content>\n...your HTML here...\n</content>\n</write_to_file>\n\nPick a sensible filename yourself (e.g. index.html for HTML, script.js for JavaScript, style.css for CSS). Reply to the user in Persian.',
          });
          forceToolRetry = true;
          continue;
        }
        forceToolRetry = false;

        messages.push({
          role: 'assistant',
          content: response.content || null,
        });

        if (nonModeSwitchCalls.length === 0) {
          break;
        }

        // Execute each parsed tool call (sequentially for predictability)
        for (const call of nonModeSwitchCalls) {
          if (this.abortController.signal.aborted) break;

          // Todo tool — no approval needed
          if (call.name === 'update_todos') {
            const todos = (call.args.todos as TodoItem[]) ?? [];
            this.callbacks.onTodosUpdate(todos);
            const result = await this.registry.execute(call.name, call.args, ctx);
            const todoMsg: ChatMessage = {
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
            this.callbacks.onToolEnd(todoMsg);
            messages.push({
              role: 'user',
              content: `[Tool result for ${call.name}]\n${result.output}`,
            });
            continue;
          }

          // Other tools — require approval based on tool definition
          const tool = this.registry.get(call.name);
          const needsApproval =
            tool?.definition.requiresApproval &&
            !(tool.definition.readOnly && this.autoApproveReadOnly);

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

          // If approval is needed, request it BEFORE showing the tool block.
          // This way the user sees only ONE element (the approval dialog),
          // not two (the pending tool block + the approval dialog).
          if (needsApproval) {
            const approval = await this.approvals.requestApproval({
              toolName: call.name,
              args: call.args,
              description: describeToolCall(call.name, call.args),
            });
            if (!approval.approved) {
              toolMsg.approvalState = 'rejected';
              toolMsg.pending = false;
              toolMsg.content = `The user rejected this operation.${approval.reason ? ` Reason: ${approval.reason}` : ''}`;
              toolMsg.toolResult = toolMsg.content;
              // Show the rejected tool block briefly so the user sees the result.
              this.callbacks.onToolStart(toolMsg);
              this.callbacks.onToolEnd(toolMsg);
              messages.push({
                role: 'user',
                content: `[Tool result for ${call.name}] ${toolMsg.content}`,
              });
              continue;
            }
            toolMsg.approvalState = approval.id === '' ? 'auto-approved' : 'approved';
          }

          // Show the tool block AFTER approval is resolved (or immediately if
          // no approval was needed). This avoids showing two elements for the
          // same operation (pending tool block + approval dialog).
          this.callbacks.onToolStart(toolMsg);

          const result = await this.registry.execute(call.name, call.args, ctx);
          toolMsg.pending = false;
          toolMsg.content = result.output;
          toolMsg.toolResult = result.output;
          toolMsg.error = result.ok ? undefined : 'خطا';
          this.callbacks.onToolEnd(toolMsg);
          messages.push({
            role: 'user',
            content: `[Tool result for ${call.name}]\n${result.output}`,
          });
        }
      }

      return [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted')) return [];
      this.callbacks.onError(msg);
      return [];
    } finally {
      this.abortController = null;
    }
  }

  private toOpenAIMessage(m: ChatMessage): ChatCompletionMessageParam {
    if (m.role === 'tool') {
      // We use a text-based tool protocol — tool results are fed back to the
      // LLM as user messages so the model sees them as observations.
      return {
        role: 'user' as const,
        content: `[Tool result for ${m.toolName ?? 'unknown'}]\n${m.content || m.toolResult || '(no output)'}`,
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
  // Avoid importing node:crypto in webview bundle (this file is host-only, but be safe).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Detect fenced code blocks (```lang\n...```) in the assistant's text response.
 * Inline code (`x`) doesn't count — only multi-line fenced blocks.
 */
function containsCodeBlock(text: string): boolean {
  if (!text) return false;
  const matches = text.match(/```[a-zA-Z0-9_-]*\n[\s\S]+?```/g);
  return !!matches && matches.length > 0;
}

/**
 * Heuristic: does the most recent user message look like a request to create
 * or write a file/code? We check for keywords in Persian and English.
 * This prevents the enforcement retry from firing on casual chat.
 */
function userMessageLooksLikeFileRequest(history: ChatMessage[]): boolean {
  // Find the last user message in history.
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const text = lastUser.content.toLowerCase();
  const keywords = [
    // Persian
    'ساز',           // بساز / بسازید / بسازم
    'بساز',
    'فایل',
    'ایجاد',
    'بنویس',
    'ذخیره',
    'ویرایش',
    'پروژه',
    'صفحه',
    'کد',
    'اسکریپت',
    'کامپوننت',
    'تابع',
    'کلاس',
    // English
    'create',
    'make',
    'build',
    'write',
    'generate',
    'file',
    'html',
    'css',
    'javascript',
    'js ',
    'ts ',
    'typescript',
    'python',
    'json',
    'script',
    'component',
    'function',
    'class',
    'project',
    'page',
    'landing',
  ];
  return keywords.some((kw) => text.includes(kw));
}
