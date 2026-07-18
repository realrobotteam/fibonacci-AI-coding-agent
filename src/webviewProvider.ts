import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type {
  AgentState,
  ApprovalRequest,
  ChatHistoryEntry,
  ChatMessage,
  HostToWebviewMessage,
  McpServerConfig,
  ModeSwitchRequest,
  TodoItem,
  WebviewToHostMessage,
} from './types';
import { FibonacciClient } from './api/fibonacciClient';
import { ToolRegistry } from './core/toolRegistry';
import { ApprovalManager } from './core/approvalManager';
import { AgentLoop } from './core/agentLoop';
import { McpManager } from './tools/mcpTools';
import type { SkillsRegistry } from './core/skillsRegistry';
import { getCurrentConfig, getModelChoices } from './extension';

interface ProviderDeps {
  client: FibonacciClient;
  registry: ToolRegistry;
  approvals: ApprovalManager;
  mcpManager: McpManager;
  skills: SkillsRegistry;
  workspaceRoot: string;
}

/**
 * Manages the sidebar webview: lifecycle, message passing, agent loop
 * orchestration, and state syncing.
 */
export class FibonacciAgentViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'fibonacci.agentView';
  private static readonly HISTORY_KEY = 'fibonacci.chatHistory';
  private static readonly MAX_HISTORY = 50;

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private pendingApprovals: ApprovalRequest[] = [];
  private currentModel: string;
  private isBusy = false;
  private agentLoop: AgentLoop;
  private currentChatId: string | null = null;
  private todos: TodoItem[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private deps: ProviderDeps
  ) {
    this.currentModel = vscode.workspace
      .getConfiguration('fibonacci')
      .get<string>('defaultModel') ?? 'fibonacci-1-pro-max';

    this.agentLoop = new AgentLoop({
      client: deps.client,
      registry: deps.registry,
      approvals: deps.approvals,
      autoApproveReadOnly: vscode.workspace.getConfiguration('fibonacci').get<boolean>('autoApproveReadOnly') ?? true,
      skills: deps.skills,
      callbacks: {
        onAssistantStart: () => {
          const id = makeId();
          const msg: ChatMessage = {
            id,
            role: 'assistant',
            content: '',
            ts: Date.now(),
            pending: true,
          };
          this.history.push(msg);
          this.post({ type: 'MESSAGE_APPEND', message: msg });
          this.setBusy(true);
          return id;
        },
        onAssistantContent: (id, content, reasoning) => {
          const msg = this.history.find((m) => m.id === id);
          if (!msg) return;
          msg.content = content;
          // CRITICAL FIX (bug J — thought is cleared):
          // Only update reasoning if it's non-empty. During streaming, the
          // parser may temporarily return empty thinking (e.g. between the
          // closing of one thought block and the opening of the next). We
          // must NOT overwrite a previously-set non-empty reasoning with
          // an empty string — that would "clear" the thinking from the UI.
          if (reasoning !== undefined && reasoning.length > 0) {
            msg.reasoning = reasoning;
          }
          this.post({ type: 'MESSAGE_UPDATE', message: msg });
        },
        onAssistantEnd: (id, content, reasoning) => {
          const msg = this.history.find((m) => m.id === id);
          if (!msg) return;
          // CRITICAL FIX (bug J): Don't overwrite content with empty string.
          // Only update if the final content is non-empty OR the current
          // content is empty.
          if (content && content.length > 0) {
            msg.content = content;
          }
          // CRITICAL FIX (bug J): Don't clear reasoning. Only update if
          // the final reasoning is non-empty. This prevents the "thought
          // is cleared" bug where the final parse returns empty thinking
          // (e.g. because the model emitted thinking in a format the parser
          // didn't catch) and overwrites the streaming thinking that was
          // already displayed.
          if (reasoning !== undefined && reasoning.length > 0) {
            msg.reasoning = reasoning;
          }
          msg.pending = false;
          // If the assistant response is empty (no prose, no reasoning) —
          // e.g. when the API returns only a tool_call with no text —
          // generate a simple acknowledgment so the user sees a response.
          const isEmpty = !msg.content?.trim() && !msg.reasoning?.trim();
          if (isEmpty) {
            // Check if there was a successful tool call before this message.
            // If so, generate a context-appropriate acknowledgment.
            const prevToolMsg = [...this.history].reverse().find(
              (m) => m.role === 'tool' && m.approvalState === 'approved'
            );
            if (prevToolMsg) {
              msg.content = 'عملیات با موفقیت انجام شد. آیا کار دیگری هست که بتوانم برایتان انجام دهم؟';
            } else {
              msg.content = ' ';  // Single space placeholder — maintains alternation
            }
          }
          this.post({ type: 'MESSAGE_UPDATE', message: msg });
        },
        onAssistantRemove: (id) => {
          // Remove an assistant message from the UI (used when the enforcement
          // detects a hallucination — the hallucinated message is removed so
          // the user doesn't see duplicate "file created" bubbles).
          this.history = this.history.filter((m) => m.id !== id);
          this.post({ type: 'MESSAGE_REMOVE', id });
        },
        onToolStart: (msg) => {
          this.history.push(msg);
          this.post({ type: 'TOOL_START', message: msg });
        },
        onToolEnd: (msg) => {
          const idx = this.history.findIndex((m) => m.id === msg.id);
          if (idx >= 0) this.history[idx] = msg;
          this.post({ type: 'TOOL_END', message: msg });
        },
        onTodosUpdate: (todos) => {
          this.updateTodos(todos);
        },
        onModeSwitchRequest: (request) => {
          return this.handleModeSwitchRequest(request);
        },
        onError: (err) => {
          // CRITICAL FIX (bug F): Guard against undefined/null error messages.
          // If the agent loop somehow passes undefined (shouldn't happen after
          // the fix in agentLoop.ts, but defensive programming), we substitute
          // a meaningful message instead of forwarding `undefined` to the webview.
          const safeMsg = (typeof err === 'string' && err.length > 0)
            ? err
            : 'خطای ناشناخته رخ داد. لطفاً تنظیمات API و اتصال شبکه را بررسی کنید. (Unknown error — check API settings and network connection.)';
          this.post({ type: 'ERROR', message: safeMsg });
          this.setBusy(false);
        },
      },
    });
  }

  /**
   * Handle a mode-switch request from the AI. Sends a popup to the webview
   * and waits for the user's response. Returns true if approved.
   */
  private pendingModeSwitch: { resolve: (approved: boolean) => void } | null = null;

  private handleModeSwitchRequest(request: ModeSwitchRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingModeSwitch = { resolve };
      this.post({ type: 'MODE_SWITCH_REQUEST', request });
    });
  }

  /** Called when the webview sends a MODE_SWITCH_RESPONSE message. */
  private resolveModeSwitch(approved: boolean): void {
    if (this.pendingModeSwitch) {
      this.pendingModeSwitch.resolve(approved);
      this.pendingModeSwitch = null;
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    console.log('[fibonacci-agent] resolveWebviewView() called');
    this.view = view;
    const distRoot = vscode.Uri.joinPath(
      this.context.extensionUri,
      'dist',
      'webview'
    );

    // Sanity-check that the bundled webview assets actually exist on disk.
    // This catches broken installs where dist/webview wasn't packaged.
    const distPath = distRoot.fsPath;
    try {
      const entries = fs.readdirSync(distPath);
      console.log('[fibonacci-agent] dist/webview contents:', entries);
      if (!entries.includes('main.js') || !entries.includes('main.css')) {
        void vscode.window.showErrorMessage(
          'فایل‌های وب‌ویو Fibonacci پیدا نشد. لطفاً افزونه را دوباره نصب کنید.'
        );
      }
    } catch (err) {
      console.error('[fibonacci-agent] dist/webview missing:', err);
      void vscode.window.showErrorMessage(
        `پوشه dist/webview وجود ندارد: ${(err as Error).message}`
      );
    }

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };

    view.webview.html = this.getHtml(view.webview, distRoot);
    console.log('[fibonacci-agent] webview HTML assigned');

    view.webview.onDidReceiveMessage(
      // CRITICAL FIX (bug F): Wrap handleMessage in a try/catch so that if
      // it throws (or rejects), the error is caught and logged — not
      // propagated as an unhandled promise rejection (which VS Code would
      // log as bare `[Extension Host] undefined`).
      (msg: WebviewToHostMessage) => {
        try {
          const result = this.handleMessage(msg);
          if (result && typeof (result as Promise<void>).catch === 'function') {
            (result as Promise<void>).catch((err) => {
              const errMsg = err instanceof Error ? err.message : (err != null ? String(err) : 'Unknown error');
              console.error('[fibonacci-agent] handleMessage async error:', errMsg);
              this.post({ type: 'ERROR', message: errMsg });
              this.setBusy(false);
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : (err != null ? String(err) : 'Unknown error');
          console.error('[fibonacci-agent] handleMessage sync error:', errMsg);
          this.post({ type: 'ERROR', message: errMsg });
          this.setBusy(false);
        }
      },
      undefined,
      this.context.subscriptions
    );

    // Push the initial state once the webview is ready.
    this.pushFullState();
    this.pushConfig();
    this.refreshServers();
    this.pushHistory();
    this.pushSkills();
    this.updateTodos(this.todos);
  }

  /** Send the skills list to the webview. */
  pushSkills(): void {
    const skills = this.deps.skills.list().map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
    }));
    this.post({ type: 'SKILLS', skills });
  }

  // --- Public API used by extension.ts commands ---

  newChat(): void {
    // Save current chat to history before clearing (if it has messages).
    if (this.history.length > 0) {
      this.saveCurrentToHistory();
    }
    this.history = [];
    this.pendingApprovals = [];
    this.todos = [];
    this.currentChatId = null;
    this.agentLoop.cancel();
    this.setBusy(false);
    this.pushFullState();
    this.updateTodos([]);
  }

  /** Save the current chat to globalState so it persists across sessions. */
  private saveCurrentToHistory(): void {
    if (this.history.length === 0) return;
    const firstUser = this.history.find((m) => m.role === 'user');
    const title = firstUser
      ? firstUser.content.slice(0, 80).replace(/\n/g, ' ').trim() || 'بدون عنوان'
      : 'بدون عنوان';
    const entry: ChatHistoryEntry = {
      id: this.currentChatId ?? makeId(),
      title,
      ts: Date.now(),
      messages: this.history,
      model: this.currentModel,
    };
    this.currentChatId = entry.id;
    const all = this.getHistory();
    // Remove any existing entry with the same id, then prepend.
    const filtered = all.filter((e) => e.id !== entry.id);
    filtered.unshift(entry);
    // Cap the history size.
    const capped = filtered.slice(0, FibonacciAgentViewProvider.MAX_HISTORY);
    void this.context.globalState.update(
      FibonacciAgentViewProvider.HISTORY_KEY,
      capped
    );
  }

  private getHistory(): ChatHistoryEntry[] {
    return (
      this.context.globalState.get<ChatHistoryEntry[]>(
        FibonacciAgentViewProvider.HISTORY_KEY
      ) ?? []
    );
  }

  /** Send a compact history summary to the webview. */
  pushHistory(): void {
    const entries = this.getHistory().map((e) => ({
      id: e.id,
      title: e.title,
      ts: e.ts,
      messageCount: e.messages.length,
      model: e.model,
    }));
    this.post({ type: 'HISTORY', entries });
  }

  /** Load a chat from history into the current session. */
  loadChat(chatId: string): void {
    // Save current chat first (if dirty).
    if (this.history.length > 0) {
      this.saveCurrentToHistory();
    }
    const entry = this.getHistory().find((e) => e.id === chatId);
    if (!entry) return;
    this.history = entry.messages;
    this.currentChatId = entry.id;
    this.currentModel = entry.model;
    this.pendingApprovals = [];
    this.todos = [];
    this.agentLoop.cancel();
    this.setBusy(false);
    this.pushFullState();
    this.updateTodos([]);
    this.post({ type: 'MODELS', models: getModelChoices(), current: entry.model });
  }

  /** Permanently delete a chat from history. */
  deleteChat(chatId: string): void {
    const all = this.getHistory().filter((e) => e.id !== chatId);
    void this.context.globalState.update(
      FibonacciAgentViewProvider.HISTORY_KEY,
      all
    );
    this.pushHistory();
  }

  switchModel(modelId: string): void {
    this.currentModel = modelId;
    this.post({ type: 'MODELS', models: getModelChoices(), current: modelId });
    this.onModelChangedCallbacks.forEach((fn) => fn(modelId));
  }

  /** Register a callback that fires when the user switches model. */
  onModelChangedCallbacks: Array<(model: string) => void> = [];
  onModelChanged(fn: (model: string) => void): void {
    this.onModelChangedCallbacks.push(fn);
  }

  /** Update the todo list visible in the webview. Called by the todo tool. */
  updateTodos(todos: TodoItem[]): void {
    this.todos = todos;
    this.post({ type: 'TODOS_UPDATE', todos });
  }

  pushConfig(): void {
    this.post({ type: 'CONFIG', config: getCurrentConfig() });
  }

  refreshServers(): void {
    const servers =
      vscode.workspace
        .getConfiguration('fibonacci')
        .get<McpServerConfig[]>('mcpServers') ?? [];
    this.post({ type: 'MCP_SERVERS', servers });
  }

  refreshPendingApprovals(): void {
    this.pendingApprovals = this.deps.approvals.listPending();
    this.pushFullState();
  }

  forwardApprovalRequest(req: ApprovalRequest): void {
    this.pendingApprovals.push(req);
    this.post({ type: 'APPROVAL_REQUEST', request: req });
  }

  // --- Internal helpers ---

  private setBusy(busy: boolean): void {
    this.isBusy = busy;
    this.pushFullState();
  }

  private async handleMessage(msg: WebviewToHostMessage): Promise<void> {
    switch (msg.type) {
      case 'SEND_MESSAGE':
        await this.handleUserMessage(msg.text);
        break;
      case 'CANCEL':
        this.agentLoop.cancel();
        this.setBusy(false);
        break;
      case 'APPROVE':
        this.deps.approvals.resolve({
          id: msg.requestId,
          approved: msg.approved,
          reason: msg.reason,
        });
        this.pendingApprovals = this.pendingApprovals.filter((p) => p.id !== msg.requestId);
        this.post({ type: 'APPROVAL_RESOLVED', id: msg.requestId, approved: msg.approved });
        break;
      case 'NEW_CHAT':
        this.newChat();
        break;
      case 'SWITCH_MODEL':
        this.switchModel(msg.modelId);
        break;
      case 'OPEN_SETTINGS':
        vscode.commands.executeCommand('workbench.action.openSettings', 'fibonacci');
        break;
      case 'SAVE_API_KEY':
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update('apiKey', msg.apiKey, vscode.ConfigurationTarget.Global);
        this.deps.client.refresh();
        this.pushConfig();
        break;
      case 'GET_STATE':
        this.pushFullState();
        break;
      case 'LIST_MCP_SERVERS':
        this.refreshServers();
        break;
      case 'ADD_MCP_SERVER': {
        const cfg = vscode.workspace.getConfiguration('fibonacci');
        const servers = (cfg.get<McpServerConfig[]>('mcpServers') ?? []).slice();
        if (servers.find((s) => s.name === msg.server.name)) {
          vscode.window.showErrorMessage('سرور با این نام وجود دارد.');
          return;
        }
        servers.push(msg.server);
        await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
        try {
          await this.deps.mcpManager.connect(msg.server);
          vscode.window.showInformationMessage(`سرور MCP «${msg.server.name}» متصل شد.`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `اتصال ناموفق: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        this.refreshServers();
        break;
      }
      case 'REMOVE_MCP_SERVER': {
        await this.deps.mcpManager.disconnect(msg.name);
        const cfg = vscode.workspace.getConfiguration('fibonacci');
        const servers = (cfg.get<McpServerConfig[]>('mcpServers') ?? []).filter(
          (s) => s.name !== msg.name
        );
        await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
        this.refreshServers();
        break;
      }
      case 'GET_MCP_TOOLS': {
        const tools = this.deps.mcpManager
          .listTools(msg.name)
          .map((t) => ({ server: t.server, name: t.name, description: t.description }));
        this.post({ type: 'MCP_TOOLS', tools });
        break;
      }
      case 'TEST_MCP_SERVER': {
        // Tests an MCP server by attempting to list its tools.
        const cfg = vscode.workspace.getConfiguration('fibonacci');
        const server = (cfg.get<McpServerConfig[]>('mcpServers') ?? []).find(
          (s) => s.name === msg.name
        );
        if (!server) {
          vscode.window.showErrorMessage('سرور یافت نشد.');
          return;
        }
        try {
          await this.deps.mcpManager.connect(server);
          vscode.window.showInformationMessage(`سرور «${msg.name}» با موفقیت متصل شد.`);
        } catch (err) {
          vscode.window.showErrorMessage(
            `خطا: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        this.refreshServers();
        break;
      }
      case 'GET_HISTORY':
        this.pushHistory();
        break;
      case 'LOAD_CHAT':
        this.loadChat(msg.chatId);
        this.pushHistory();
        break;
      case 'DELETE_CHAT':
        this.deleteChat(msg.chatId);
        break;
      case 'MODE_SWITCH_RESPONSE':
        this.resolveModeSwitch(msg.approved);
        break;
      case 'GET_SKILLS':
        this.pushSkills();
        break;
      case 'INVOKE_SKILL': {
        const skill = this.deps.skills.get(msg.name);
        if (!skill) {
          vscode.window.showErrorMessage(`مهارت «${msg.name}» یافت نشد.`);
          return;
        }
        // Inject the skill body as a user message so the agent follows it.
        const argStr = msg.args ? `\n\nArguments: ${JSON.stringify(msg.args)}` : '';
        const invokeText = `[Skill invoked: ${skill.name}]\n\n${skill.body}${argStr}`;
        await this.handleUserMessage(invokeText);
        break;
      }
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!this.deps.client.isConfigured) {
      vscode.window
        .showErrorMessage('کلید API Fibonacci تنظیم نشده است.', 'باز کردن تنظیمات')
        .then((choice) => {
          if (choice === 'باز کردن تنظیمات') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'fibonacci');
          }
        });
      return;
    }
    if (this.isBusy) {
      vscode.window.showWarningMessage('عامل در حال انجام کار است. لغو کنید یا صبر کنید.');
      return;
    }

    const userMsg: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    this.history.push(userMsg);
    this.post({ type: 'MESSAGE_APPEND', message: userMsg });

    this.setBusy(true);
    try {
      // Determine initial mode from the [PLAN MODE] tag the webview adds.
      const initialMode = text.startsWith('[PLAN MODE]') ? 'plan' : 'coding';
      await this.agentLoop.run(
        this.history,
        this.currentModel,
        this.deps.workspaceRoot,
        initialMode,
        () => {
          // When the AI switches mode mid-run, notify the webview.
          this.post({
            type: 'CONFIG',
            config: getCurrentConfig(),
          });
        }
      );
      // Auto-save the chat to history after the agent finishes.
      this.saveCurrentToHistory();
      this.pushHistory();
    } catch (err) {
      // CRITICAL FIX (bug F): Catch any errors that escape the agent loop.
      // The agent loop has its own try/catch, but defensive programming means
      // we should never let an error propagate from here to the webview
      // message handler (where it would become an unhandled rejection).
      const errMsg = err instanceof Error
        ? (err.message || 'Unknown error (empty message)')
        : (err != null ? String(err) : 'Unknown error (undefined)');
      console.error('[fibonacci-agent] handleUserMessage error:', errMsg);
      this.post({ type: 'ERROR', message: errMsg });
    } finally {
      this.setBusy(false);
    }
  }

  private post(msg: HostToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private pushFullState(): void {
    const state: AgentState = {
      messages: this.history,
      pendingApprovals: this.pendingApprovals,
      isBusy: this.isBusy,
      currentModel: this.currentModel,
      models: getModelChoices(),
      config: getCurrentConfig(),
      mcpServers:
        vscode.workspace
          .getConfiguration('fibonacci')
          .get<McpServerConfig[]>('mcpServers') ?? [],
    };
    this.post({ type: 'STATE', state });
  }

  private getHtml(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'main.css'));
    const nonce = getNonce();
    // CSP note: VS Code webviews internally register a service worker to bootstrap
    // the webview document. We must therefore allow ${webview.cspSource} in both
    // script-src and worker-src — otherwise the webview fails with
    // "Could not register service worker: InvalidStateError".
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src ${webview.cspSource} 'unsafe-inline' 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} http://my.fibonacci.monster https://my.fibonacci.monster https:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" />
  <title>Fibonacci Agent</title>
</head>
<body class="font-persian">
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
