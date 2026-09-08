import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import type {
  AgentState,
  ApprovalRequest,
  AutoApproveMode,
  ChatHistoryEntry,
  ChatMessage,
  CustomMode,
  HostToWebviewMessage,
  McpServerConfig,
  ModeSwitchRequest,
  SkillDefinition,
  SkillSource,
  SubtaskInfo,
  TodoItem,
  TokenUsage,
  WebviewToHostMessage,
} from './types';
import { buildModeTag, stripModeTag } from './types';
import { FibonacciClient } from './api/fibonacciClient';
import { ToolRegistry } from './core/toolRegistry';
import { ApprovalManager } from './core/approvalManager';
import { AgentLoop } from './core/agentLoop';
import { McpManager } from './tools/mcpTools';
import { CheckpointManager } from './core/checkpoints';
import { FILE_MUTATING_TOOLS, computeFileEditDiff, openApprovalDiff } from './core/diffPreview';
import { estimateTokens } from './core/pricing';
import { buildSystemPrompt, type ToolFormat } from './core/systemPrompt';
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
  private static readonly CUSTOM_SKILLS_KEY = 'fibonacci.customSkills';

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private pendingApprovals: ApprovalRequest[] = [];
  private currentModel: string;
  /** True when the user explicitly picked a model in the header — that choice
   *  then wins over the per-mode model assignments for the session. */
  private modelOverride = false;
  private isBusy = false;
  private agentLoop: AgentLoop;
  private currentChatId: string | null = null;
  private todos: TodoItem[] = [];
  private streamingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statePushQueued = false;
  /** Cline-style per-edit snapshots + restore (constructed lazily-cheap). */
  private checkpoints: CheckpointManager;
  /** Cached ContextBar breakdown (system/tools tokens) — 30s TTL. */
  private tokenBreakdown: { key: string; at: number; systemTokens: number; toolsTokens: number } | null = null;
  /** delegate_task subtask board: the tool message currently showing the
   *  live board + nesting depth. Orchestrator-role subagents can call
   *  delegate_task again through the SAME shared registry — inner hooks
   *  must not finalize the outer board while its subagents still run. */
  private activeDelegateMsgId: string | null = null;
  private delegateNesting = 0;

  /**
   * Pre-execution before/after diffs for file-mutating tool calls, keyed by
   * the tool message id. Backs the chat card's persistent "open diff" button
   * (OPEN_TOOL_DIFF). Persisted to workspaceState (capped) so it survives
   * reloads; entries carry ≤48 KB per side to keep the state payload sane.
   */
  private toolDiffCache = new Map<string, { path: string; before: string; after: string; ts: number }>();
  private toolDiffCacheDirty = false;
  private static readonly TOOL_DIFF_CACHE_KEY = 'fibonacci.toolDiffCache.v1';
  private static readonly TOOL_DIFF_CACHE_MAX = 20;
  private static readonly TOOL_DIFF_SIDE_CAP = 48 * 1024;

  /** Timestamp (ms) captured when the current assistant message was created
   *  (onAssistantStart) — used to compute the Kilo-style generation speed
   *  (completion tokens/sec) in onAssistantEnd. Reset on chat resets. */
  private assistantStartTs = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private deps: ProviderDeps
  ) {
    this.currentModel = vscode.workspace
      .getConfiguration('fibonacci')
      .get<string>('defaultModel') ?? 'fibonacci-1-pro-max';

    this.checkpoints = new CheckpointManager(this.context);

    // Restore the persisted tool-diff cache (OPEN_TOOL_DIFF support across
    // window reloads). Best-effort — a corrupt payload just means no cache.
    try {
      const saved = this.context.workspaceState.get<Array<{ id: string; path: string; before: string; after: string; ts: number }>>(
        FibonacciAgentViewProvider.TOOL_DIFF_CACHE_KEY
      );
      if (Array.isArray(saved)) {
        for (const e of saved.slice(-FibonacciAgentViewProvider.TOOL_DIFF_CACHE_MAX)) {
          if (e && typeof e.id === 'string' && typeof e.path === 'string') {
            this.toolDiffCache.set(e.id, { path: e.path, before: e.before ?? '', after: e.after ?? '', ts: e.ts ?? 0 });
          }
        }
      }
    } catch (cacheErr) {
      console.error('[fibonacci-agent] tool diff cache restore failed:', cacheErr);
    }

    // Wire the registry execution hooks (single choke point): snapshot files
    // BEFORE each file-mutating tool runs, and append VS Code diagnostics
    // errors AFTER it ran (Cline-style self-healing feedback). The same two
    // helpers also cover the preview-approval commit path (commitPreview
    // bypasses registry.execute) via the agent-loop callbacks below.
    this.deps.registry.setHooks({
      beforeTool: (name, args) => {
        this.snapshotCheckpoint(name, args);
        // Subtask board: anchor the live delegate_task tool message so the
        // onSubtaskEvent stream (wired via setDelegateTaskDeps in
        // extension.ts) knows where to merge subagent status.
        if (name === 'delegate_task') this.trackDelegateToolStart();
      },
      afterTool: async (name, args, output) => {
        // Subtask board finalize BEFORE anything else (sync, non-fatal).
        if (name === 'delegate_task') this.finalizeDelegateSubtasks();
        const block = await this.gatherAutoDiagnostics(name, args);
        return block ? output + block : output;
      },
    });

    this.agentLoop = new AgentLoop({
      client: deps.client,
      registry: deps.registry,
      approvals: deps.approvals,
      autoApproveMode: (vscode.workspace.getConfiguration('fibonacci').get<string>('autoApproveMode') as AutoApproveMode) ?? 'none',
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
          // Remember when this assistant turn started so onAssistantEnd can
          // compute the generation speed (tokens/sec) from the usage payload.
          this.assistantStartTs = msg.ts;
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
          // Throttle: send MESSAGE_UPDATE at most once per 100ms per message
          // to prevent UI freezes from rapid token-by-token updates.
          if (!this.streamingTimers.has(id)) {
            this.streamingTimers.set(id, setTimeout(() => {
              this.streamingTimers.delete(id);
              const latest = this.history.find((m) => m.id === id);
              if (latest) this.post({ type: 'MESSAGE_UPDATE', message: latest });
            }, 100));
          }
        },
        onAssistantEnd: (id, content, reasoning, usage?: TokenUsage) => {
          // Clear any pending throttle timer so the final update is sent immediately.
          const pendingTimer = this.streamingTimers.get(id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.streamingTimers.delete(id);
          }
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
          // Persist the per-turn token usage + estimated cost (ContextBar /
          // MessageBubble cost footnote).
          if (usage) {
            msg.usage = usage;
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
          // Kilo-style generation speed ("102.6 t/s"): completion tokens per
          // second for this turn, from the usage payload captured by the
          // client. Cosmetic metric — computed defensively, never throws, and
          // left undefined when it cannot be computed (no usage payload,
          // sub-0.5s turns, or non-positive token counts).
          try {
            const elapsedMs = Date.now() - this.assistantStartTs;
            if (
              usage &&
              typeof usage.completionTokens === 'number' &&
              Number.isFinite(usage.completionTokens) &&
              usage.completionTokens > 0 &&
              elapsedMs >= 500
            ) {
              const elapsedSec = elapsedMs / 1000;
              msg.tokensPerSec = Math.round((usage.completionTokens / elapsedSec) * 10) / 10;
            }
          } catch {
            /* metric only — never break message finalization */
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
        onToolDiffData: (messageId, path, before, after) => {
          try {
            this.cacheToolDiff(messageId, path, before, after);
          } catch (cacheErr) {
            console.error('[fibonacci-agent] tool diff cache failed:', cacheErr);
          }
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
        // Coverage for the PREVIEW-approval commit path (commitPreview bypasses
        // registry.execute, so the registry hooks above don't fire there):
        // snapshot checkpoints before the write lands, gather auto-diagnostics
        // after — identical behavior to the 17-a registry hooks.
        beforePreviewCommit: async (toolName, args) => {
          this.snapshotCheckpoint(toolName, args);
        },
        afterPreviewCommit: (toolName, args) => this.gatherAutoDiagnostics(toolName, args),
      },
    });

    // Restore custom (GitHub-installed) skills persisted from previous sessions.
    const savedSkills = this.context.globalState.get<SkillDefinition[]>(
      FibonacciAgentViewProvider.CUSTOM_SKILLS_KEY
    );
    for (const s of savedSkills ?? []) {
      this.deps.skills.register({ ...s, source: 'github' });
    }
  }

  /**
   * Handle a mode-switch request from the AI. Sends a popup to the webview
   * and waits for the user's response. Returns true if approved.
   */
  private pendingModeSwitch: { resolve: (approved: boolean) => void } | null = null;

  private handleModeSwitchRequest(request: ModeSwitchRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Defensive: if an older request is somehow still pending, retire it so
      // its promise can never orphan the loop (a promise that is never
      // resolved keeps agentLoop.run() awaiting forever → isBusy stuck true).
      if (this.pendingModeSwitch) {
        this.pendingModeSwitch.resolve(false);
      }
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

  /**
   * FIX (in-flight dialog cleanup): cancelling a run or resetting/switching
   * the chat used to leave host-side waiters dangling:
   *  1. A pending mode-switch promise. The dialog is the only thing that can
   *     answer it — if the webview is destroyed before the user answers
   *     (sidebar panel closed & reopened, webview crash), the promise can
   *     NEVER resolve, agentLoop.run() awaits forever, and isBusy stays true
   *     → after reopening the panel the composer is permanently disabled
   *     (extension bricked until a window reload).
   *  2. Approval entries left in ApprovalManager.pending after the loop had
   *     already been rejected via its abort race — the next emit() re-pushed
   *     them into a brand-new chat as ghost dialogs. (cancelAll also unwinds
   *     awaits that are NOT raced against the abort signal, e.g.
   *     createFallbackFile's requestApproval, which otherwise hang on Cancel.)
   *
   * This retires both: the mode-switch promise resolves as "rejected", every
   * pending approval resolves as cancelled, and the webview overlay is
   * dismissed via a null MODE_SWITCH_REQUEST. Safe to call repeatedly.
   */
  private resetTransientDialogState(): void {
    if (this.pendingModeSwitch) {
      this.pendingModeSwitch.resolve(false);
      this.pendingModeSwitch = null;
    }
    this.deps.approvals.cancelAll();
    this.pendingApprovals = [];
    // Subtask-board tracking can't outlive the run/chat it belonged to.
    this.activeDelegateMsgId = null;
    this.delegateNesting = 0;
    this.post({ type: 'MODE_SWITCH_REQUEST', request: null });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    console.debug('[fibonacci-agent] resolveWebviewView() called');
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
      console.debug('[fibonacci-agent] dist/webview contents:', entries);
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
    console.debug('[fibonacci-agent] webview HTML assigned');

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

  /** Send the skills list to the webview (including install-source metadata). */
  pushSkills(): void {
    const skills = this.deps.skills.list().map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      source: (s.source ?? 'builtin') as SkillSource,
      repoUrl: s.repoUrl,
    }));
    this.post({ type: 'SKILLS', skills });
  }

  /** Persist all GitHub-sourced skills so they survive restarts. */
  private persistCustomSkills(): void {
    const custom = this.deps.skills.list().filter((s) => s.source === 'github');
    void this.context.globalState.update(
      FibonacciAgentViewProvider.CUSTOM_SKILLS_KEY,
      custom
    );
  }

  /**
   * Download and parse a skill definition from a GitHub URL.
   *
   * Accepts any of:
   *   - https://github.com/owner/repo                      → looks for SKILL.md / skill.md / README.md on main|master
   *   - https://github.com/owner/repo/tree/branch/sub/dir  → same lookup inside sub/dir
   *   - https://github.com/owner/repo/blob/branch/SKILL.md → direct file
   *   - raw.githubusercontent.com URLs
   *
   * Metadata (name/description/category) is read from an optional YAML-lite
   * frontmatter block (`---` delimited); sensible fallbacks are derived from
   * the filename/repo name.
   */
  private async fetchSkillFromGithub(rawUrl: string): Promise<SkillDefinition | null> {
    const url = rawUrl.trim().replace(/\/+$/, '');
    const gh = url.match(
      /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(tree|blob)\/([^/]+)((?:\/[\w.\-/~]*)?))?$/i
    );
    if (!gh) {
      // Direct raw URL?
      if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(url)) {
        const body = await fetchText(url);
        return body ? toSkillDefinition(url, body) : null;
      }
      throw new Error('لینک واردشده یک آدرس معتبر گیت‌هاب نیست.');
    }
    const [, owner, repo, kind, branchRaw, pathRaw] = gh;
    const dir = kind === 'tree' && pathRaw ? pathRaw.replace(/^\//, '') : '';
    const explicitFile =
      kind === 'blob' && pathRaw ? decodeURIComponent(pathRaw.replace(/^\//, '')) : null;

    let candidates: string[] = [];
    if (explicitFile) {
      candidates = [explicitFile];
    } else {
      const branches = branchRaw ? [decodeURIComponent(branchRaw)] : ['main', 'master'];
      for (const b of branches) {
        for (const f of ['SKILL.md', 'skill.md', 'README.md']) {
          candidates.push(dir ? `${b}/${dir}/${f}` : `${b}/${f}`);
        }
      }
    }

    for (const candidate of candidates) {
      const rawUrl2 = `https://raw.githubusercontent.com/${owner}/${repo}/${candidate}`;
      const body = await fetchText(rawUrl2);
      if (body) return toSkillDefinition(rawUrl2, body);
    }
    return null;
  }


  // --- Public API used by extension.ts commands ---

  /**
   * delegate_task subtask lifecycle event (wired via setDelegateTaskDeps in
   * extension.ts). Merges the event into the tracked tool message's subtask
   * board (upsert by id, initializing the array on first event) and re-posts
   * the message as MESSAGE_UPDATE. Never throws — the board is cosmetic.
   */
  handleSubtaskEvent(evt: SubtaskInfo): void {
    try {
      const msg = this.findDelegateMessage();
      if (!msg) return;
      this.activeDelegateMsgId = msg.id;
      if (!Array.isArray(msg.subtasks)) msg.subtasks = [];
      const idx = msg.subtasks.findIndex((t) => t.id === evt.id);
      if (idx >= 0) {
        msg.subtasks[idx] = { ...msg.subtasks[idx], ...evt };
      } else {
        msg.subtasks.push(evt);
      }
      this.post({ type: 'MESSAGE_UPDATE', message: msg });
    } catch (err) {
      console.debug('[fibonacci-agent] subtask event handling failed:', err);
    }
  }

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
    this.assistantStartTs = 0;
    // FIX (in-flight dialog cleanup): retire the mode-switch promise and any
    // pending approvals so nothing dangles across the chat reset.
    this.resetTransientDialogState();
    this.setBusy(false);
    this.pushFullState();
    this.updateTodos([]);
    // FIX (stale history panel): newChat() saves the just-closed chat to
    // globalState but never pushed the refreshed list, so the entry was
    // missing from the history panel until the webview reloaded. Mirror
    // loadChat/deleteChat/renameChat which all pushHistory().
    this.pushHistory();
  }

  /**
   * Derive a compact chat title from the first user prompt: strip mode tags
   * and markdown noise, collapse whitespace, cut at a natural boundary and
   * cap the length so history lists stay readable.
   */
  private summarizeTitle(raw: string): string {
    let s = stripModeTag(raw || '');
    // Strip common markdown decoration that looks noisy in a title.
    s = s.replace(/^[#>\s]+/gm, '');          // headings / quotes
    s = s.replace(/`{1,3}/g, '');             // code fences / ticks
    s = s.replace(/\*\*?|__/g, '');           // bold / italic markers
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [text](url) → text
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return 'بدون عنوان';
    // Prefer cutting at sentence/punctuation boundary within the cap.
    const cap = 48;
    if (s.length <= cap) return s;
    const head = s.slice(0, cap);
    const cutAt = Math.max(head.lastIndexOf(' '), head.lastIndexOf('،'), head.lastIndexOf(','), head.lastIndexOf('.'));
    return (cutAt >= 20 ? head.slice(0, cutAt) : head).trimEnd() + '…';
  }

  /** Save the current chat to globalState so it persists across sessions. */
  private saveCurrentToHistory(): void {
    if (this.history.length === 0) return;
    const firstUser = this.history.find((m) => m.role === 'user');
    const id = this.currentChatId ?? makeId();
    const existing = this.getHistory().find((e) => e.id === id);
    // Auto-title from a summary of the first prompt — unless the user renamed it manually.
    const title = existing?.titleCustom
      ? existing.title
      : this.summarizeTitle(firstUser?.content ?? '');
    const entry: ChatHistoryEntry = {
      id,
      title,
      titleCustom: existing?.titleCustom ?? false,
      // Preserve the manual pin across re-saves (same rationale as titleCustom).
      pinned: existing?.pinned ?? false,
      ts: Date.now(),
      messages: this.history.map(m => ({
        ...m,
        // Vision attachments (multi-MB data URLs) live in the CURRENT chat
        // only — they are stripped from the persisted snapshot to keep
        // globalState small.
        images: undefined,
        content:
          typeof m.content === 'string' && m.content.length > 50_000
            ? m.content.slice(0, 50_000) + '\n[...truncated in saved history...]'
            : m.content,
      })),
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
    // FIX (unimplemented historyPath): the fibonacci.historyPath setting was
    // documented but never used — best-effort mirror the saved chat to disk
    // so users can access their transcripts outside globalState.
    this.mirrorToDisk(entry);
  }

  /** Best-effort: write the chat entry as JSON under fibonacci.historyPath. */
  private mirrorToDisk(entry: ChatHistoryEntry): void {
    try {
      const raw = vscode.workspace
        .getConfiguration('fibonacci')
        .get<string>('historyPath');
      if (!raw) return;
      const expanded = raw.startsWith('~')
        ? nodePath.join(os.homedir(), raw.slice(1))
        : raw;
      fs.mkdirSync(expanded, { recursive: true });
      const file = nodePath.join(expanded, `${entry.id}.json`);
      fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      // Never fail the chat because of a disk-mirror problem.
      console.debug('[fibonacci-agent] historyPath mirror failed:', err);
    }
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
    const entries = this.getHistory().map((e) => {
      const firstUser = e.messages.find((m) => m.role === 'user');
      return {
        id: e.id,
        title: e.title,
        ts: e.ts,
        // Count only real conversation turns — tool-result messages are internal
        // activity lines, not messages, and inflated the numbers shown on the
        // main page and in the history panel.
        messageCount: e.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
        model: e.model,
        pinned: !!e.pinned,
        // Short preview of the first prompt (mode-tag stripped) for list rows.
        snippet: firstUser ? stripModeTag(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 80) : '',
      };
    });
    // Pinned chats first, then newest first.
    entries.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.ts - a.ts));
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
    // A loaded chat keeps using the model it was created with — treat it as
    // an explicit override so per-mode assignments don't hijack it mid-chat.
    this.modelOverride = true;
    this.pendingApprovals = [];
    this.todos = [];
    this.agentLoop.cancel();
    // FIX (in-flight dialog cleanup): retire mode-switch/approval waiters so
    // the previous chat's dialogs can't dangle into the loaded one.
    this.resetTransientDialogState();
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
    // FIX (deleted-chat resurrection): if the user deleted the chat that is
    // currently open, reset to a fresh chat. Otherwise the in-memory messages
    // stayed loaded and the next auto-save re-inserted the "deleted" entry
    // under the same id, so the chat reappeared in history.
    if (this.currentChatId === chatId) {
      this.currentChatId = null;
      this.history = [];
      this.pendingApprovals = [];
      this.todos = [];
      this.agentLoop.cancel();
      // FIX (in-flight dialog cleanup): same retirement as newChat/loadChat.
      this.resetTransientDialogState();
      this.setBusy(false);
      this.pushFullState();
      this.updateTodos([]);
    }
    this.pushHistory();
  }

  /** Rename a chat in history. */
  renameChat(chatId: string, newTitle: string): void {
    const all = this.getHistory().map((e) =>
      e.id === chatId ? { ...e, title: newTitle, titleCustom: true } : e
    );
    void this.context.globalState.update(
      FibonacciAgentViewProvider.HISTORY_KEY,
      all
    );
    this.pushHistory();
  }

  /**
   * Handle prompt improvement — sends the current draft to the model for
   * a rewrite/upgrade pass, then shows the improved version for the user
   * to accept, edit, or discard.
   */
  private pendingImprovePrompt: { resolve: (improved: string | null) => void } | null = null;

  private async handleImprovePrompt(text: string): Promise<void> {
    try {
      // Call the model to improve the prompt
      const improvementPrompt = `You are a prompt improvement assistant. Rewrite the following user prompt to be clearer, more specific, and more actionable. Preserve the original intent but make it more effective. Return ONLY the improved prompt without any explanation or labels.\n\nOriginal prompt:\n${text}`;
      
      // Use the FibonacciClient to send this request (with the current model)
      const improved = await this.deps.client.improvePrompt(improvementPrompt, this.currentModel);
      
      // Send the improved version back to the webview
      const finalImproved = improved || text; // fallback to original if empty
      this.post({ type: 'IMPROVED_PROMPT', original: text, improved: finalImproved });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[fibonacci-agent] handleImprovePrompt error:', errMsg);
      this.post({ type: 'ERROR', message: `Failed to improve prompt: ${errMsg}` });
    }
  }

  switchModel(modelId: string): void {
    this.currentModel = modelId;
    this.modelOverride = true;
    this.post({ type: 'MODELS', models: getModelChoices(), current: modelId });
    this.onModelChangedCallbacks.forEach((fn) => fn(modelId));
  }

  /**
   * Find a connected provider (enabled + non-empty apiKey) that offers the
   * given model id. Returns null when the run should use the global fibonacci
   * endpoint. First match wins when several providers expose the same model.
   */
  private resolveProviderForModel(modelId: string): import('./types').ProviderConfig | null {
    const providers = getCurrentConfig().providers ?? [];
    return (
      providers.find(
        (p) => p.enabled && typeof p.apiKey === 'string' && p.apiKey.length > 0 &&
          Array.isArray(p.models) && p.models.some((m) => m && m.id === modelId)
      ) ?? null
    );
  }

  /** Register a callback that fires when the user switches model. */
  onModelChangedCallbacks: Array<(model: string) => void> = [];
  onModelChanged(fn: (model: string) => void): void {
    this.onModelChangedCallbacks.push(fn);
  }

  /** Update the todo list visible in the webview. Called by the todo tool. */
  updateTodos(todos: TodoItem[]): void {
    // FIX (e.filter crash): never let a non-array reach the webview renderer.
    const safe: TodoItem[] = Array.isArray(todos) ? todos : [];
    this.todos = safe;
    this.post({ type: 'TODOS_UPDATE', todos: safe });
  }

  /**
   * FIX (stuck "typing forever" bubble): when a run ends abnormally — the
   * user cancels while the FIRST token is still pending (the SDK's create()
   * throws an abort error, the loop's catch swallows it and returns without
   * calling onAssistantEnd), or a stream error fires before any content —
   * the assistant message created by onAssistantStart stays pending:true
   * forever. The bubble shows eternal typing dots, gets persisted into
   * saved history by saveCurrentToHistory(), and reappears stuck when the
   * chat is reopened. Tool rows cancelled mid-run keep pulsing the same way.
   *
   * This finalizer sweeps such messages after a run finishes (or right when
   * the user cancels): partially-streamed responses are kept and marked done,
   * empty ones are removed from the chat entirely. Idempotent — a no-op
   * after normal completion (onAssistantEnd already cleared the flags).
   */
  private finalizeStuckMessages(): void {
    const stuckAssistantIds: string[] = [];
    let changed = false;
    for (const m of this.history) {
      if (m.role === 'assistant' && m.pending) {
        const timer = this.streamingTimers.get(m.id);
        if (timer) {
          clearTimeout(timer);
          this.streamingTimers.delete(m.id);
        }
        m.pending = false;
        changed = true;
        if (m.content && m.content.trim().length > 0) {
          // Keep whatever the model managed to stream before the cutoff.
          this.post({ type: 'MESSAGE_UPDATE', message: m });
        } else {
          // Nothing was streamed — an empty bubble (or eternal typing dots)
          // is pure noise; drop the message from chat and history.
          stuckAssistantIds.push(m.id);
        }
      }
      if (m.role === 'tool' && m.pending) {
        m.pending = false;
        changed = true;
        if (m.approvalState === 'pending') {
          // Cancelled while awaiting approval / mid-execution — it never ran.
          m.approvalState = 'rejected';
        }
        this.post({ type: 'MESSAGE_UPDATE', message: m });
      }
    }
    if (stuckAssistantIds.length > 0) {
      this.history = this.history.filter((m) => !stuckAssistantIds.includes(m.id));
      for (const id of stuckAssistantIds) {
        this.post({ type: 'MESSAGE_REMOVE', id });
      }
      changed = true;
    }
    if (changed) {
      this.pushFullState();
    }
  }

  pushConfig(): void {
    this.post({ type: 'CONFIG', config: this.getCurrentConfigWithBreakdown() });
  }

  /**
   * AgentConfig enriched with the ContextBar token breakdown (system prompt +
   * tool definitions) — computed lazily with a 30s cache keyed by the inputs
   * that actually change the numbers.
   */
  private getCurrentConfigWithBreakdown(): import('./types').AgentConfig {
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    const base = getCurrentConfig();
    try {
      const hermesMode = cfg.get<boolean>('hermesMode') ?? true;
      const language = (cfg.get<string>('language') as 'fa' | 'en') ?? 'fa';
      const maxIterations = cfg.get<number>('maxIterations') ?? 25;
      const showReasoning = cfg.get<boolean>('showReasoning') ?? true;
      // Repo-map + custom-mode flags participate in the key so the token
      // estimates invalidate as soon as the system-prompt inputs change.
      // ghostText does not change the prompt, but it rides along so CONFIG
      // pushes re-estimate whenever agent-level flags flip (cheap, 30s TTL).
      const repoMap = cfg.get<boolean>('repoMap') ?? true;
      const storedModes = cfg.get<CustomMode[]>('customModes');
      const customModesCount = (Array.isArray(storedModes) ? storedModes : []).length;
      const ghostText = cfg.get<boolean>('ghostText') ?? false;
      const skillCount = this.deps.skills.list().length;
      const toolCount = this.deps.registry.list().length;
      const key = [hermesMode, language, maxIterations, showReasoning, skillCount, toolCount, this.currentModel, repoMap, customModesCount, ghostText].join('|');
      const now = Date.now();
      if (!this.tokenBreakdown || this.tokenBreakdown.key !== key || now - this.tokenBreakdown.at > 30_000) {
        const toolFormat: ToolFormat = hermesMode ? 'hermes' : 'xml';
        const systemPrompt = buildSystemPrompt({
          mode: 'coding',
          toolFormat,
          skills: this.deps.skills.list(),
          workspaceRoot: this.deps.workspaceRoot,
          language,
          currentDate: new Date().toISOString().slice(0, 10),
          modelName: this.currentModel,
          maxIterations,
          enableReasoning: showReasoning,
        });
        this.tokenBreakdown = {
          key,
          at: now,
          systemTokens: estimateTokens(systemPrompt),
          toolsTokens: estimateTokens(JSON.stringify(this.deps.registry.toOpenAITools())),
        };
      }
      return {
        ...base,
        systemTokens: this.tokenBreakdown.systemTokens,
        toolsTokens: this.tokenBreakdown.toolsTokens,
      };
    } catch {
      // Breakdown is cosmetic — never fail a config push over it.
      return base;
    }
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
        await this.handleUserMessage(msg.text, msg.images);
        break;
      case 'CANCEL':
        this.agentLoop.cancel();
        // FIX (in-flight dialog cleanup): retire mode-switch/approval waiters
        // BEFORE anything else so no promise can outlive the cancelled run.
        this.resetTransientDialogState();
        // FIX (stuck typing indicator): sweep now — the aborted run may take
        // a moment to unwind, and the user should not keep watching typing
        // dots after pressing Cancel. Idempotent with the post-run sweep.
        this.finalizeStuckMessages();
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
      case 'RENAME_CHAT':
        this.renameChat(msg.chatId, msg.title);
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
      case 'SET_AGENT_MODE': {
        // Update the agent mode in the config
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update('agentMode', msg.mode, vscode.ConfigurationTarget.Global);
        this.pushConfig();
        break;
      }
      case 'SAVE_CUSTOM_MODE': {
        await this.handleSaveCustomMode(msg.mode);
        break;
      }
      case 'DELETE_CUSTOM_MODE': {
        await this.handleDeleteCustomMode(msg.id);
        break;
      }
      case 'SET_AUTO_APPROVE_MODE': {
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update('autoApproveMode', msg.mode, vscode.ConfigurationTarget.Global);
        this.deps.approvals.setAutoApproveMode(msg.mode);
        const autoCfg = getCurrentConfig();
        autoCfg.autoApproveMode = msg.mode;
        this.post({ type: 'CONFIG', config: autoCfg });
        break;
      }
      case 'SET_CONFIG': {
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        // Send config directly with the updated value instead of re-reading
        const updatedCfg = getCurrentConfig();
        (updatedCfg as unknown as Record<string, unknown>)[msg.key] = msg.value;
        this.post({ type: 'CONFIG', config: updatedCfg });
        break;
      }
      case 'IMPROVE_PROMPT': {
        await this.handleImprovePrompt(msg.text);
        break;
      }
      case 'EDIT_USER_MESSAGE': {
        // FIX (race): mutate history ONLY when idle. Both this handler and
        // REGENERATE used to truncate history before handleUserMessage's
        // internal busy check — if a run was in flight, the history was cut
        // down and nothing re-ran, silently destroying the conversation.
        if (this.isBusy) {
          vscode.window.showWarningMessage('عامل در حال انجام کار است. لغو کنید یا صبر کنید.');
          return;
        }
        // Truncate host-side history at the edited user message and re-run the
        // agent loop with the new text. Previously only the webview trimmed its
        // local copy while the host kept stale turns, corrupting the next run.
        let idx = -1;
        for (let i = this.history.length - 1; i >= 0; i--) {
          const m = this.history[i];
          if (m.role === 'user' && stripModeTag(m.content) === stripModeTag(msg.previousText)) {
            idx = i;
            break;
          }
        }
        if (idx === -1) {
          vscode.window.showWarningMessage('پیام اصلی برای ویرایش یافت نشد.');
          return;
        }
        this.history = this.history.slice(0, idx);
        this.pushFullState();
        await this.handleUserMessage(buildModeTag(msg.mode) + msg.newText);
        break;
      }
      case 'REGENERATE': {
        // FIX (race): same as EDIT_USER_MESSAGE — never truncate history
        // while a run is still in flight.
        if (this.isBusy) {
          vscode.window.showWarningMessage('عامل در حال انجام کار است. لغو کنید یا صبر کنید.');
          return;
        }
        // FIX (regenerate corrupted the conversation): the webview used to
        // locally trim its message copy and re-post SEND_MESSAGE. The host
        // kept the old answer + tool turns and then appended the prompt a
        // second time, so the model saw a duplicated turn and a stale
        // response. The rewind is now host-owned: drop everything from the
        // last user prompt onward, then re-run that prompt through the
        // normal pipeline (it re-appends the prompt with a fresh id and
        // re-derives the mode from its tag).
        let lastUserIdx = -1;
        for (let i = this.history.length - 1; i >= 0; i--) {
          if (this.history[i].role === 'user') {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx === -1) {
          vscode.window.showWarningMessage('پیامی برای تولید مجدد وجود ندارد.');
          return;
        }
        const promptText = this.history[lastUserIdx].content;
        this.history = this.history.slice(0, lastUserIdx);
        this.pushFullState();
        await this.handleUserMessage(promptText);
        break;
      }
      case 'ADD_SKILL_FROM_GITHUB': {
        // FIX (install feedback): the webview used to infer install completion
        // by watching skills.length — which never changes when RE-installing
        // (update) and stays unchanged when the install FAILS, leaving the
        // button stuck on "installing…" for a 12s backstop. The host now
        // acknowledges every outcome with an explicit SKILL_INSTALL_RESULT.
        const reportResult = (ok: boolean, name?: string, error?: string): void => {
          this.post({ type: 'SKILL_INSTALL_RESULT', ok, name, error });
        };
        try {
          const skill = await this.fetchSkillFromGithub(msg.url);
          if (!skill) {
            vscode.window.showErrorMessage(
              `مهارتی در «${msg.url}» پیدا نشد. یک لینک مخزن گیت‌هاب یا مسیر مستقیم SKILL.md بدهید.`
            );
            reportResult(false, undefined, 'not-found');
            return;
          }
          // Guard: never let a GitHub skill silently overwrite a BUILT-IN
          // skill of the same name — removing the GitHub copy would then
          // delete the entry entirely and the builtin would stay gone until
          // an extension restart.
          const existing = this.deps.skills.get(skill.name);
          if (existing && existing.source !== 'github') {
            vscode.window.showErrorMessage(
              `نام مهارت «${skill.name}» با یک مهارت داخلی تداخل دارد. در frontmatter فایل مقدار name دیگری بگذارید.`
            );
            reportResult(false, skill.name, 'builtin-collision');
            return;
          }
          if (existing) {
            this.deps.skills.unregister(skill.name);
          }
          this.deps.skills.register({ ...skill, source: 'github', repoUrl: msg.url });
          this.persistCustomSkills();
          this.pushSkills();
          vscode.window.showInformationMessage(`مهارت «${skill.name}» نصب شد.`);
          reportResult(true, skill.name);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`خطا در نصب مهارت از گیت‌هاب: ${detail}`);
          reportResult(false, undefined, detail);
        }
        break;
      }
      case 'REMOVE_CUSTOM_SKILL': {
        const skill = this.deps.skills.get(msg.name);
        if (!skill || skill.source !== 'github') return;
        this.deps.skills.unregister(msg.name);
        this.persistCustomSkills();
        this.pushSkills();
        vscode.window.showInformationMessage(`مهارت «${msg.name}» حذف شد.`);
        break;
      }
      case 'GET_TOOL_LIST': {
        const tools = this.deps.registry.list().map((t) => ({
          name: t.name,
          category: t.category,
          readOnly: t.readOnly ?? false,
          requiresApproval: t.requiresApproval,
        }));
        this.post({ type: 'TOOL_LIST', tools });
        break;
      }
      case 'SET_PROVIDERS': {
        // Persist the Providers-tab draft. Minimal shape validation — keep the
        // settings.json clean even if the webview sends partial rows.
        const incoming = Array.isArray(msg.providers) ? msg.providers : [];
        const clean: import('./types').ProviderConfig[] = [];
        for (const p of incoming) {
          if (!p || typeof p.id !== 'string' || p.id.length === 0) continue;
          if (typeof p.baseURL !== 'string' || p.baseURL.length === 0) continue;
          if (clean.some((c) => c.id === p.id)) continue; // dedupe by id
          clean.push({
            id: p.id,
            name: typeof p.name === 'string' && p.name.length > 0 ? p.name : p.id,
            baseURL: p.baseURL,
            apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
            models: Array.isArray(p.models) ? p.models : [],
            enabled: p.enabled !== false,
          });
        }
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update('providers', clean, vscode.ConfigurationTarget.Global);
        this.pushConfig();
        break;
      }
      case 'SET_MODEL_ASSIGNMENTS': {
        const validModes = ['coding', 'plan', 'ask', 'debug', 'auto'] as const;
        const assignments: Record<string, string> = {};
        for (const mode of validModes) {
          const v = (msg.assignments as Record<string, unknown>)?.[mode];
          if (typeof v === 'string' && v.length > 0) assignments[mode] = v;
        }
        await vscode.workspace
          .getConfiguration('fibonacci')
          .update('modelAssignment', assignments, vscode.ConfigurationTarget.Global);
        this.pushConfig();
        break;
      }
      case 'TEST_PROVIDER_CONNECTION': {
        // Test by attempting a real request to the provider. The webview sends
        // the CURRENT DRAFT entry (`msg.provider`) so the test reflects unsaved
        // edits; otherwise resolve from the merged saved view (defaults +
        // persisted rows — previously the raw saved key was read, which was
        // always empty, so EVERY test failed with "Provider not found").
        try {
          const provider =
            msg.provider ??
            (getCurrentConfig().providers ?? []).find((p) => p.id === msg.providerId);
          if (!provider || typeof provider.baseURL !== 'string' || !provider.baseURL) {
            this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: false, error: 'Provider not found' });
            break;
          }
          const baseURL = provider.baseURL.replace(/\/+$/, '');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          try {
            if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) {
              // With a key: list models (OpenAI-compatible). The x-api-key /
              // anthropic-version headers are sent alongside — endpoints that
              // don't use them ignore them, so one request covers all.
              const resp = await fetch(`${baseURL}/models`, {
                headers: {
                  Authorization: `Bearer ${provider.apiKey}`,
                  'x-api-key': provider.apiKey,
                  'anthropic-version': '2023-06-01',
                },
                signal: controller.signal,
              });
              clearTimeout(timeout);
              if (resp.ok) {
                this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: true });
              } else if (resp.status === 401 || resp.status === 403) {
                this.post({
                  type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: false,
                  error: `کلید API رد شد (HTTP ${resp.status}) — کلید را بررسی کنید`,
                });
              } else if (resp.status === 404 || resp.status === 405) {
                // Endpoint reachable but no /models route — treat as reachable.
                this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: true });
              } else {
                this.post({
                  type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: false,
                  error: `پاسخ HTTP ${resp.status} از سرور`,
                });
              }
            } else {
              // Without a key we can only check reachability — any HTTP
              // response means the endpoint exists (a HEAD to the base URL is
              // commonly 404/405 even on healthy endpoints).
              await fetch(baseURL, { method: 'HEAD', signal: controller.signal });
              clearTimeout(timeout);
              this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: true });
            }
          } catch {
            clearTimeout(timeout);
            this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: false, error: 'Connection failed' });
          }
        } catch (err) {
          this.post({ type: 'PROVIDER_TEST_RESULT', providerId: msg.providerId, ok: false, error: String(err) });
        }
        break;
      }
      case 'RESET_SETTINGS': {
        const cfg = vscode.workspace.getConfiguration('fibonacci');
        const keys = [
          'autoApproveMode', 'enableMCP', 'hermesMode', 'showReasoning',
          'parallelToolCalls', 'maxIterations', 'themeBehavior', 'uiStyle', 'startupView',
          'notifyOnTaskComplete', 'contextCompression', 'toolOverrides',
          // Persisted provider/model-assignment state — previously reset was
          // asymmetric with export (which DID include these keys).
          'modelAssignment', 'providers',
        ];
        for (const key of keys) {
          await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
        this.pushConfig();
        break;
      }
      case 'EXPORT_SETTINGS': {
        const cfg = vscode.workspace.getConfiguration('fibonacci');
        const allSettings: Record<string, unknown> = {};
        for (const key of [
          'apiKey', 'baseURL', 'defaultModel', 'professionalModel', 'language',
          'enableMCP', 'autoApproveMode', 'maxIterations', 'hermesMode',
          'showReasoning', 'parallelToolCalls', 'themeBehavior', 'uiStyle', 'startupView',
          'notifyOnTaskComplete', 'contextCompression', 'toolOverrides',
          'modelAssignment', 'mcpServers', 'providers',
        ]) {
          const val = cfg.get(key);
          if (val !== undefined) allSettings[key] = val;
        }
        this.post({ type: 'SETTINGS_EXPORT', data: JSON.stringify(allSettings, null, 2) });
        break;
      }
      case 'IMPORT_SETTINGS': {
        try {
          const data = JSON.parse(msg.data) as Record<string, unknown>;
          const cfg = vscode.workspace.getConfiguration('fibonacci');
          for (const [key, value] of Object.entries(data)) {
            await cfg.update(key, value, vscode.ConfigurationTarget.Global);
          }
          this.pushConfig();
          vscode.window.showInformationMessage('تنظیمات با موفقیت وارد شد.');
        } catch {
          vscode.window.showErrorMessage('خطا در وارد کردن تنظیمات — فایل معتبر نیست.');
        }
        break;
      }
      case 'OPEN_DIFF': {
        await this.handleOpenDiff(msg.requestId);
        break;
      }
      case 'OPEN_TOOL_DIFF': {
        await this.handleOpenToolDiff(msg.messageId);
        break;
      }
      case 'RESTORE_CHECKPOINT': {
        // Busy-guard: restoring files mid-run would corrupt the run's view of
        // the workspace (the loop may hold pending writes for those paths).
        if (this.agentLoop.isRunning) break;
        const result = this.checkpoints.restore(this.deps.workspaceRoot, msg.checkpointId);
        this.post({
          type: 'CHECKPOINT_RESTORED',
          checkpointId: msg.checkpointId,
          restored: result.restored,
          errors: result.errors.length ? result.errors : undefined,
        });
        if (result.restored > 0) {
          this.pushFullState();
        }
        break;
      }
      case 'CONDENSE_CONTEXT': {
        await this.handleCondenseContext();
        break;
      }
      case 'EXPORT_CHAT': {
        await this.handleExportChat();
        break;
      }
      case 'FORK_CHAT': {
        this.handleForkChat(msg.messageId);
        break;
      }
      case 'SET_HISTORY_PIN': {
        this.handleSetHistoryPin(msg.id, msg.pinned);
        break;
      }
      case 'SEARCH_WORKSPACE_FILES': {
        await this.handleSearchWorkspaceFiles(msg.query);
        break;
      }
    }
  }

  // --- Custom user modes (Settings → Modes) --------------------------------

  /** Built-in mode ids a custom mode must never silently shadow. */
  private static readonly BUILTIN_MODE_IDS = new Set(['coding', 'plan', 'ask', 'debug', 'auto']);
  private static readonly MAX_CUSTOM_MODES = 20;
  private static readonly MAX_MODE_PROMPT_CHARS = 8000;

  /** Slugify a mode id to [a-z0-9-]{1,32}. */
  private slugifyModeId(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/^-+|-+$/g, '');
  }

  /** Upsert (or add) a user-defined mode, then persist + pushConfig(). */
  private async handleSaveCustomMode(raw: CustomMode): Promise<void> {
    try {
      const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
      const prompt = typeof raw?.prompt === 'string' ? raw.prompt.trim() : '';
      if (!name || !prompt) {
        vscode.window.showErrorMessage('حالت سفارشی به «نام» و «دستورالعمل» غیرخالی نیاز دارد.');
        return;
      }

      // Id: slugify what the webview sent; when missing/empty after
      // slugification, derive from the latin characters of the name, and
      // finally fall back to a timestamp-based id.
      let id = this.slugifyModeId(typeof raw?.id === 'string' ? raw.id : '');
      if (!id) {
        id = this.slugifyModeId(name.replace(/[^a-zA-Z0-9]/g, ''));
      }
      if (!id) {
        id = `mode-${Date.now().toString(36)}`;
      }
      // Never silently shadow a built-in mode — suffix instead.
      if (FibonacciAgentViewProvider.BUILTIN_MODE_IDS.has(id)) {
        id = this.slugifyModeId(`${id}-custom`) || `mode-${Date.now().toString(36)}`;
      }

      const mode: CustomMode = {
        id,
        name,
        icon: typeof raw?.icon === 'string' && raw.icon ? raw.icon : '✨',
        // Cap the prompt so a huge mode body can't blow up the system prompt.
        prompt: prompt.slice(0, FibonacciAgentViewProvider.MAX_MODE_PROMPT_CHARS),
      };
      const tools = Array.isArray(raw?.tools)
        ? raw.tools.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : [];
      if (tools.length > 0) {
        mode.tools = tools;
      }

      const cfg = vscode.workspace.getConfiguration('fibonacci');
      const storedModes = cfg.get<CustomMode[]>('customModes');
      const modes = (Array.isArray(storedModes) ? storedModes : []).slice();
      const idx = modes.findIndex((m) => m && m.id === id);
      if (idx >= 0) {
        modes[idx] = mode; // upsert by id
      } else {
        if (modes.length >= FibonacciAgentViewProvider.MAX_CUSTOM_MODES) {
          vscode.window.showErrorMessage(
            `حداکثر ${FibonacciAgentViewProvider.MAX_CUSTOM_MODES} حالت سفارشی مجاز است. ابتدا یکی را حذف کنید.`
          );
          return;
        }
        modes.push(mode);
      }
      await cfg.update('customModes', modes, vscode.ConfigurationTarget.Global);
      this.pushConfig();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`خطا در ذخیره حالت سفارشی: ${detail}`);
    }
  }

  /** Delete a user-defined mode by id; fall back to 'coding' if it was active. */
  private async handleDeleteCustomMode(id: string): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('fibonacci');
      const storedModes = cfg.get<CustomMode[]>('customModes');
      const modes = Array.isArray(storedModes) ? storedModes : [];
      const next = modes.filter((m) => m && m.id !== id);
      if (next.length === modes.length) return; // unknown id — nothing to do
      await cfg.update('customModes', next, vscode.ConfigurationTarget.Global);
      // If the deleted mode was the persisted active mode, switch back to coding.
      const active = cfg.get<string>('agentMode');
      if (active === id) {
        await cfg.update('agentMode', 'coding', vscode.ConfigurationTarget.Global);
      }
      this.pushConfig();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`خطا در حذف حالت سفارشی: ${detail}`);
    }
  }

  // --- Checkpoints + auto-diagnostics (registry hooks + preview commits) ----

  /**
   * Snapshot target files BEFORE a file-mutating tool runs (Cline-style).
   * Fired from the registry beforeTool hook AND from the agent-loop
   * beforePreviewCommit callback (preview-approved writes).
   */
  private snapshotCheckpoint(toolName: string, args: Record<string, unknown>): void {
    try {
      if (!FILE_MUTATING_TOOLS.has(toolName)) return;
      const cfg = vscode.workspace.getConfiguration('fibonacci');
      if (cfg.get<boolean>('checkpoints') === false) return;
      const rel = typeof args.path === 'string' ? args.path : '';
      if (!rel) return;
      const meta = this.checkpoints.create(this.deps.workspaceRoot, [rel], `${toolName} · ${rel}`);
      if (meta) {
        this.post({ type: 'CHECKPOINT', checkpoint: meta });
      }
    } catch (err) {
      // Checkpoints are a safety net — never block the tool over one.
      console.debug('[fibonacci-agent] checkpoint create failed:', err);
    }
  }

  /**
   * Collect VS Code diagnostics errors for a file that was just edited
   * (self-healing). Returns '' when disabled/not applicable, otherwise the
   * block WITH its leading "\n\n" separator — callers append it to the tool
   * output verbatim (same convention as the 17-a afterTool hook).
   * Fired from the registry afterTool hook AND from the agent-loop
   * afterPreviewCommit callback (preview-approved writes).
   */
  private async gatherAutoDiagnostics(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    try {
      const cfg = vscode.workspace.getConfiguration('fibonacci');
      const enabled = cfg.get<boolean>('autoDiagnostics') ?? true;
      if (!enabled || !FILE_MUTATING_TOOLS.has(toolName)) return '';
      const rel = typeof args.path === 'string' ? args.path : '';
      if (!rel) return '';
      // Give language servers a beat to publish fresh diagnostics.
      await new Promise((r) => setTimeout(r, 600));
      const abs = nodePath.resolve(this.deps.workspaceRoot, rel);
      const uri = vscode.Uri.file(abs);
      const errors = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      let block = `\n\n[auto-diagnostics] ${rel}`;
      if (errors.length === 0) {
        block += ': no errors';
      } else {
        const lines: string[] = [];
        for (const d of errors) {
          lines.push(`<error> line ${d.range.start.line + 1}: ${d.message.split('\n')[0]}`);
          if (lines.length >= 8) break; // cap 8 lines
        }
        block += '\n' + lines.join('\n');
      }
      if (block.length > 1200) {
        block = block.slice(0, 1200) + '…';
      }
      return block;
    } catch {
      return '';
    }
  }

  // --- delegate_task subtask board (wave 20) ---------------------------------

  /**
   * registry beforeTool hook for delegate_task. The hook only receives
   * (toolName, args) — no message id — so the target tool message is located
   * positionally: agentLoop pushes the tool message via onToolStart BEFORE
   * registry.execute(), so at beforeTool time the LAST 'delegate_task'
   * message in history with a non-terminal approvalState is the one running.
   */
  private trackDelegateToolStart(): void {
    try {
      this.delegateNesting++;
      for (let i = this.history.length - 1; i >= 0; i--) {
        const m = this.history[i];
        if (
          m.toolName === 'delegate_task' &&
          (m.approvalState === 'pending' ||
            m.approvalState === 'approved' ||
            m.approvalState === 'auto-approved')
        ) {
          this.activeDelegateMsgId = m.id;
          return;
        }
      }
    } catch (err) {
      console.debug('[fibonacci-agent] delegate subtask tracking failed:', err);
    }
  }

  /**
   * Resolve the tool message that owns the live subtask board: the tracked
   * id when still valid, otherwise (e.g. after a finalize cleared it, or for
   * execute_code-invoked delegation) the last delegate_task message from the
   * end of history whose subtasks are NOT all terminal yet.
   */
  private findDelegateMessage(): ChatMessage | null {
    if (this.activeDelegateMsgId) {
      const byId = this.history.find((m) => m.id === this.activeDelegateMsgId);
      if (byId) return byId;
    }
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.toolName !== 'delegate_task') continue;
      const tasks = Array.isArray(m.subtasks) ? m.subtasks : [];
      const allTerminal = tasks.length > 0 && tasks.every((t) => t.status !== 'running');
      if (!allTerminal) return m;
    }
    return null;
  }

  /**
   * registry afterTool hook for delegate_task: mark any subtask still
   * 'running' as failed ('interrupted'), re-post the message, and clear the
   * tracking anchor — but ONLY when the OUTERMOST delegation finishes (the
   * nesting counter guards against orchestrator subagents whose inner
   * delegate_task calls fire the same hooks through the shared registry).
   */
  private finalizeDelegateSubtasks(): void {
    try {
      this.delegateNesting = Math.max(0, this.delegateNesting - 1);
      if (this.delegateNesting > 0) return;
      const msg = this.findDelegateMessage();
      this.activeDelegateMsgId = null;
      if (!msg) return;
      let changed = false;
      for (const t of Array.isArray(msg.subtasks) ? msg.subtasks : []) {
        if (t.status === 'running') {
          t.status = 'failed';
          t.error = 'interrupted';
          changed = true;
        }
      }
      if (changed) {
        this.post({ type: 'MESSAGE_UPDATE', message: msg });
      }
    } catch (err) {
      console.debug('[fibonacci-agent] delegate subtask finalize failed:', err);
    }
  }

  // --- Diff review for pending approvals ------------------------------------

  private async handleOpenDiff(requestId: string): Promise<void> {
    const req = this.pendingApprovals.find((p) => p.id === requestId);
    if (!req) {
      // Approval already resolved — send empty data so the webview can clear
      // its pending preview state.
      this.post({ type: 'APPROVAL_DIFF_DATA', requestId, path: '', before: '', after: '' });
      return;
    }
    const path = typeof req.args?.path === 'string' ? req.args.path : '';
    let before = '';
    let after = '';
    if (FILE_MUTATING_TOOLS.has(req.toolName) && path) {
      try {
        const diff = await computeFileEditDiff(req.toolName, req.args, this.deps.workspaceRoot);
        before = diff.before;
        after = diff.after;
      } catch (err) {
        console.error('[fibonacci-agent] computeFileEditDiff failed:', err);
      }
    }
    this.post({ type: 'APPROVAL_DIFF_DATA', requestId, path, before, after });
    // Also open a real VS Code diff editor (before vs after).
    if (path) {
      openApprovalDiff(path, before, after);
    }
  }

  // --- Tool-call diff cache (Kilo-style "open diff" on chat cards) ----------

  /**
   * Store the pre-execution before/after for a file-mutating tool call and
   * persist the (capped) cache to workspaceState. Throttled: writes at most
   * once per second during a run.
   */
  private cacheToolDiff(messageId: string, path: string, before: string, after: string): void {
    const cap = FibonacciAgentViewProvider.TOOL_DIFF_SIDE_CAP;
    this.toolDiffCache.set(messageId, {
      path,
      before: before.length > cap ? before.slice(0, cap) + '\n…[truncated]' : before,
      after: after.length > cap ? after.slice(0, cap) + '\n…[truncated]' : after,
      ts: Date.now(),
    });
    while (this.toolDiffCache.size > FibonacciAgentViewProvider.TOOL_DIFF_CACHE_MAX) {
      const oldest = this.toolDiffCache.keys().next().value;
      if (oldest === undefined) break;
      this.toolDiffCache.delete(oldest);
    }
    if (this.toolDiffCacheDirty) return;
    this.toolDiffCacheDirty = true;
    setTimeout(() => {
      this.toolDiffCacheDirty = false;
      this.persistToolDiffCache();
    }, 1000);
  }

  private persistToolDiffCache(): void {
    try {
      const entries = Array.from(this.toolDiffCache.entries()).map(([id, e]) => ({
        id,
        path: e.path,
        before: e.before,
        after: e.after,
        ts: e.ts,
      }));
      void this.context.workspaceState.update(FibonacciAgentViewProvider.TOOL_DIFF_CACHE_KEY, entries);
    } catch (err) {
      console.error('[fibonacci-agent] tool diff cache persist failed:', err);
    }
  }

  /**
   * Re-open the official VS Code diff editor for a completed file-mutating
   * tool call (chat card button). Uses the cached pre-execution diff when
   * available; otherwise falls back to diffing current disk vs the predicted
   * after (best effort for chats from older sessions).
   */
  private async handleOpenToolDiff(messageId: string): Promise<void> {
    const msg = this.history.find((m) => m.id === messageId);
    if (!msg || !msg.toolName || !FILE_MUTATING_TOOLS.has(msg.toolName)) return;
    const path = typeof msg.toolArgs?.path === 'string' ? msg.toolArgs.path : '';
    if (!path) return;

    const cached = this.toolDiffCache.get(messageId);
    if (cached) {
      openApprovalDiff(cached.path, cached.before, cached.after);
      return;
    }
    try {
      const diff = await computeFileEditDiff(msg.toolName, msg.toolArgs ?? {}, this.deps.workspaceRoot);
      openApprovalDiff(path, diff.before, diff.after);
    } catch (err) {
      console.error('[fibonacci-agent] open tool diff failed:', err);
    }
  }

  // --- Condense / export / fork / pin / file search -------------------------

  /** Replace the conversation with a model-generated summary in place. */
  private async handleCondenseContext(): Promise<void> {
    try {
      if (this.agentLoop.isRunning || this.isBusy) {
        this.post({ type: 'CONDENSE_RESULT', ok: false, error: 'busy' });
        return;
      }
      const users = this.history.filter((m) => m.role === 'user');
      const assistants = this.history.filter((m) => m.role === 'assistant');
      if (users.length + assistants.length < 2 || users.length === 0 || assistants.length === 0) {
        this.post({ type: 'CONDENSE_RESULT', ok: false, error: 'not-enough-messages' });
        return;
      }
      const language = (vscode.workspace.getConfiguration('fibonacci').get<string>('language') as 'fa' | 'en') ?? 'fa';
      const isFa = language === 'fa';

      // Serialize the visible conversation (tool activity lines skipped).
      let transcript = '';
      for (const m of this.history) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        transcript += `[${m.role}]\n${stripModeTag(m.content)}\n\n`;
        if (transcript.length > 40_000) {
          transcript = transcript.slice(0, 40_000) + '\n…[truncated]';
          break;
        }
      }
      const beforeTokens = estimateTokens(this.history.map((m) => m.content).join('\n'));

      const systemContent = isFa
        ? 'خلاصهٔ دقیق و فشرده‌ای از این گفت‌وگو تهیه کن. تمام نکات فنی، تصمیم‌ها، نام فایل‌ها، کدهای مهم و کارهای باقی‌مانده را حفظ کن. فقط متن خلاصه را برگردان، بدون مقدمه.'
        : 'Summarize the conversation into a compact brief. Preserve all technical details, decisions, file names, important code, and remaining work. Return only the summary text, without preamble.';
      const userContent = isFa
        ? `گفت‌وگوی زیر را خلاصه کن:\n\n${transcript}`
        : `Summarize the following conversation:\n\n${transcript}`;

      const response = await this.deps.client.chat({
        model: this.currentModel,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
      });
      const summary = response.content.trim();
      if (!summary) throw new Error('empty summary');

      const now = Date.now();
      this.history = [
        {
          id: makeId(),
          role: 'user',
          content: '[CONDENSED CONTEXT]\n\n' + summary,
          ts: now,
          pending: false,
        },
        {
          id: makeId(),
          role: 'assistant',
          content: isFa
            ? '(یادداشت: تاریخچهٔ قبلی فشرده شد — خلاصه در پیام بالا است)'
            : '(Note: previous history was condensed — see summary above.)',
          ts: now + 1,
          pending: false,
        },
      ];
      const afterTokens = estimateTokens(this.history.map((m) => m.content).join('\n'));

      // Persist directly (the condensed transcript must not be re-titled from
      // "[CONDENSED CONTEXT]" — keep the previous entry title).
      const id = this.currentChatId ?? makeId();
      const existing = this.getHistory().find((e) => e.id === id);
      const entry: ChatHistoryEntry = {
        id,
        title: existing?.title ?? 'گفت‌وگوی فشرده‌شده',
        titleCustom: existing?.titleCustom ?? false,
        pinned: existing?.pinned ?? false,
        ts: Date.now(),
        messages: this.history,
        model: this.currentModel,
      };
      this.currentChatId = entry.id;
      const all = this.getHistory().filter((e) => e.id !== entry.id);
      all.unshift(entry);
      void this.context.globalState.update(
        FibonacciAgentViewProvider.HISTORY_KEY,
        all.slice(0, FibonacciAgentViewProvider.MAX_HISTORY)
      );

      this.pushFullState();
      this.pushHistory();
      this.post({ type: 'CONDENSE_RESULT', ok: true, beforeTokens, afterTokens });
    } catch (err) {
      this.post({
        type: 'CONDENSE_RESULT',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Export the current chat as a Markdown file (via a save dialog). */
  private async handleExportChat(): Promise<void> {
    try {
      const firstUser = this.history.find((m) => m.role === 'user');
      const currentEntry = this.currentChatId
        ? this.getHistory().find((e) => e.id === this.currentChatId)
        : undefined;
      const title = currentEntry?.title ?? this.summarizeTitle(firstUser?.content ?? '');

      const lines: string[] = [];
      lines.push(`# ${title}`, '', `- Model: ${this.currentModel}`, `- Date: ${new Date().toISOString()}`, '', '---', '');
      for (const m of this.history) {
        if (m.role === 'user' || m.role === 'assistant') {
          lines.push(`## ${m.role}`, '', stripModeTag(m.content), '');
          if (m.reasoning) {
            lines.push('<details>', '<summary>Reasoning</summary>', '', '```', m.reasoning, '```', '', '</details>', '');
          }
        } else if (m.role === 'tool' && m.toolName) {
          // Compact tool-activity line with the target path when available.
          const p = typeof m.toolArgs?.path === 'string' ? (m.toolArgs.path as string) : '';
          lines.push(`> 🔧 ${m.toolName}${p ? `(${p})` : ''}`, '');
        }
      }
      const markdown = lines.join('\n');

      const slug =
        title
          .toLowerCase()
          .replace(/[^\w\u0600-\u06FF]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'chat';
      const defaultUri = vscode.Uri.file(nodePath.join(this.deps.workspaceRoot, `${slug}.md`));
      const target = await vscode.window.showSaveDialog({
        filters: { Markdown: ['md'] },
        defaultUri,
      });
      if (!target) {
        // User cancelled the dialog — report so any UI spinner can unwind.
        this.post({ type: 'EXPORT_RESULT', ok: false, error: 'cancelled' });
        return;
      }
      await fs.promises.writeFile(target.fsPath, markdown, 'utf-8');
      this.post({ type: 'EXPORT_RESULT', ok: true, path: target.fsPath });
    } catch (err) {
      this.post({
        type: 'EXPORT_RESULT',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Branch a new chat from an assistant message (keeps the original intact). */
  private handleForkChat(messageId: string): void {
    if (this.isBusy || this.agentLoop.isRunning) return;
    const idx = this.history.findIndex((m) => m.id === messageId);
    if (idx === -1 || this.history[idx].role !== 'assistant') return;

    // Persist the ORIGINAL chat first so the fork never replaces it.
    this.saveCurrentToHistory();
    const originalEntry = this.currentChatId
      ? this.getHistory().find((e) => e.id === this.currentChatId)
      : undefined;

    const copy = structuredClone(this.history.slice(0, idx + 1));
    const newChatId = makeId();
    const firstUser = copy.find((m) => m.role === 'user');
    const baseTitle = originalEntry?.title ?? this.summarizeTitle(firstUser?.content ?? '');
    const entry: ChatHistoryEntry = {
      id: newChatId,
      title: `${baseTitle} (fork)`,
      ts: Date.now(),
      // Persist WITHOUT vision attachments (same rule as saveCurrentToHistory)
      // while the live forked chat keeps its images.
      messages: copy.map((m) => ({ ...m, images: undefined })),
      model: this.currentModel,
    };
    const all = this.getHistory().filter((e) => e.id !== newChatId);
    all.unshift(entry);
    void this.context.globalState.update(
      FibonacciAgentViewProvider.HISTORY_KEY,
      all.slice(0, FibonacciAgentViewProvider.MAX_HISTORY)
    );

    this.currentChatId = newChatId;
    this.history = copy;
    this.resetTransientDialogState();
    this.pushFullState();
    this.pushHistory();
    this.post({ type: 'FORK_CREATED', chatId: newChatId });
  }

  /** Pin/unpin a stored history entry (works even for older entries). */
  private handleSetHistoryPin(id: string, pinned: boolean): void {
    const all = this.getHistory().map((e) => (e.id === id ? { ...e, pinned } : e));
    void this.context.globalState.update(FibonacciAgentViewProvider.HISTORY_KEY, all);
    this.pushHistory();
  }

  /** Workspace file search for the @-mention autocomplete (host stays cheap). */
  private async handleSearchWorkspaceFiles(query: string): Promise<void> {
    let files: string[] = [];
    try {
      const q = query.trim();
      if (q) {
        // Escape regex-special characters so the glob is literal; queries with
        // a path separator only get a trailing * (a leading **/ would miss
        // nested dirs, **/* prefix already covers them).
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = q.includes('/') ? `**/${q}*` : `**/*${escaped}*`;
        const matches = await vscode.workspace.findFiles(
          pattern,
          '**/{node_modules,dist,out,.git}/**',
          24
        );
        // Shortest relative paths first — likely the most relevant matches.
        matches.sort((a, b) => a.fsPath.length - b.fsPath.length);
        files = matches.map((f) => vscode.workspace.asRelativePath(f, false));
      }
    } catch {
      files = [];
    }
    this.post({ type: 'WORKSPACE_FILES', files });
  }

  private async handleUserMessage(text: string, images?: string[]): Promise<void> {
    if (this.isBusy) {
      vscode.window.showWarningMessage('عامل در حال انجام کار است. لغو کنید یا صبر کنید.');
      return;
    }

    // Determine initial mode from the mode tag the webview adds.
    // FIX: recognize ALL mode tags ([PLAN/ASK/DEBUG/AUTO MODE]) — previously
    // only [PLAN MODE] switched the host-side mode. The slug is open-ended so
    // CUSTOM user-mode ids (e.g. [MY-MODE MODE], produced by buildModeTag for
    // any non-coding mode) flow into the agent loop too; unknown ids simply
    // resolve as coding-like modes (no CustomMode found → no prompt inject).
    const MODE_TAG_RE = /^\[([A-Z0-9_-]+) MODE\]/i;
    const tagMatch = text.match(MODE_TAG_RE);
    const initialMode = (tagMatch
      ? (tagMatch[1].toLowerCase() as import('./types').AgentMode)
      : 'coding');

    // Resolve the effective model for this run: an explicit header model
    // switch wins for the session; otherwise the per-mode assignment from
    // the Models settings tab applies (previously those assignments were
    // write-only — nothing ever consumed them). Custom user modes have no
    // assignment entry — the plain record lookup yields undefined and falls
    // back to the current/default model (never throws).
    const assignments = getCurrentConfig().modelAssignments ?? ({} as Record<import('./types').AgentMode, string>);
    const runModel = this.modelOverride
      ? this.currentModel
      : (assignments[initialMode] || this.currentModel);

    // Route through a connected provider when the model belongs to one
    // (enabled + apiKey set). Falls back to the global fibonacci endpoint.
    const provider = this.resolveProviderForModel(runModel);

    // Gate: need EITHER the global API key or a matching connected provider.
    // Runs BEFORE any state mutation (history/busy) so a blocked send leaves
    // nothing behind.
    if (!provider && !this.deps.client.isConfigured) {
      vscode.window
        .showErrorMessage('کلید API Fibonacci تنظیم نشده است.', 'باز کردن تنظیمات')
        .then((choice) => {
          if (choice === 'باز کردن تنظیمات') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'fibonacci');
          }
        });
      return;
    }

    const userMsg: ChatMessage = {
      id: makeId(),
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    // Vision input: attach sanitized image data URLs (MESSAGE_APPEND carries
    // them to the UI; toOpenAIMessage turns them into image_url parts).
    const safeImages = this.sanitizeImages(images);
    if (safeImages.length > 0) {
      userMsg.images = safeImages;
    }
    this.history.push(userMsg);
    this.post({ type: 'MESSAGE_APPEND', message: userMsg });

    this.setBusy(true);
    try {
      await this.agentLoop.run(
        this.history,
        runModel,
        this.deps.workspaceRoot,
        initialMode,
        () => {
          // When the AI switches mode mid-run, notify the webview.
          this.post({
            type: 'CONFIG',
            config: getCurrentConfig(),
          });
        },
        provider
      );
      // FIX (stuck typing indicator): sweep any pending assistant/tool rows
      // the loop left behind (cancel before the first token, stream error)
      // BEFORE auto-saving, so the stuck state is never persisted.
      this.finalizeStuckMessages();
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
      // FIX (stuck typing indicator): a thrown stream error also leaves the
      // onAssistantStart bubble pending forever — sweep before showing the
      // error toast. saveCurrentToHistory is skipped on this path, but the
      // in-memory history must still be clean for the next run.
      this.finalizeStuckMessages();
      this.post({ type: 'ERROR', message: errMsg });
    } finally {
      this.setBusy(false);
    }
  }

  /** Max attached images per message and per-image data-URL char cap. */
  private static readonly MAX_IMAGES_PER_MESSAGE = 4;
  private static readonly MAX_IMAGE_DATAURL_CHARS = 6_000_000;

  /**
   * Validate inbound vision attachments: keep at most 4 entries that are
   * strings starting with `data:image/` and ≤6M chars each; anything else is
   * silently dropped (an attachment must never fail a send).
   */
  private sanitizeImages(images: unknown): string[] {
    if (!Array.isArray(images)) return [];
    const out: string[] = [];
    for (const img of images) {
      if (out.length >= FibonacciAgentViewProvider.MAX_IMAGES_PER_MESSAGE) break;
      if (typeof img !== 'string') continue;
      if (!img.startsWith('data:image/')) continue;
      if (img.length > FibonacciAgentViewProvider.MAX_IMAGE_DATAURL_CHARS) continue;
      out.push(img);
    }
    return out;
  }

  private post(msg: HostToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /** Public method to send messages to the webview (e.g., theme changes). */
  public sendToWebview(msg: HostToWebviewMessage): void {
    this.post(msg);
  }

  private pushFullState(): void {
    if (this.statePushQueued) return;
    this.statePushQueued = true;
    setTimeout(() => {
      this.statePushQueued = false;
      const state: AgentState = {
        messages: this.history,
        pendingApprovals: this.pendingApprovals,
        isBusy: this.isBusy,
        currentModel: this.currentModel,
        models: getModelChoices(),
        config: this.getCurrentConfigWithBreakdown(),
        mcpServers:
          vscode.workspace
            .getConfiguration('fibonacci')
            .get<McpServerConfig[]>('mcpServers') ?? [],
      };
      this.post({ type: 'STATE', state });
    }, 50);
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
      // FIX (XSS defense-in-depth): the script is nonce-loaded — drop
      // 'unsafe-inline' so injected inline handlers can't execute even if a
      // renderer bug slips HTML through.
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      // Tightened: only the API origins + webview resources. The webview does
      // not need general https: connectivity.
      `connect-src ${webview.cspSource} http://my.fibonacci.monster https://my.fibonacci.monster`,
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

/** Fetch a raw text document; returns null on 404/parse-guard failures. */
async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    // Guard against GitHub's HTML 404 pages served with a 200 in edge cases.
    if (text.trimStart().startsWith('<')) return null;
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a SkillDefinition from fetched markdown (frontmatter-aware). */
function toSkillDefinition(sourceUrl: string, body: string): SkillDefinition {
  const fallbackName =
    sourceUrl
      .split('/')
      .filter(Boolean)
      .pop()
      ?.replace(/\.md$/i, '')
      ?.toLowerCase() ?? 'github-skill';

  const meta: Record<string, string> = {};
  let md = body;
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/);
      if (m) {
        meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    md = body.slice(fm[0].length);
  }

  // Description fallback: first markdown paragraph or heading text.
  let description = meta.description ?? '';
  if (!description) {
    const h1 = md.match(/^#\s+(.+)$/m)?.[1];
    const para = md
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('```'));
    description = (para ?? h1 ?? fallbackName).slice(0, 80);
  }

  const nameRaw = meta.name ?? fallbackName;
  const name = nameRaw
    .toLowerCase()
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'github-skill';

  const categoryRaw = (meta.category ?? 'general').toLowerCase();
  const category = ['debug', 'refactor', 'test', 'explain', 'plan', 'general'].includes(categoryRaw)
    ? (categoryRaw as SkillDefinition['category'])
    : 'general' as const;

  return {
    name,
    description,
    category,
    body: md.trim(),
    source: 'github',
  };
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
