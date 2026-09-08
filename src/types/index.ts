// Shared types between extension host and webview.
// Keep this file dependency-free so it can be imported from both sides.

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'developer';

/** Built-in modes plus user-defined custom modes (matched by CustomMode.id). */
export type AgentMode = 'coding' | 'plan' | 'ask' | 'debug' | 'auto' | (string & {});

export type AutoApproveMode = 'none' | 'read-only' | 'all';

/** A user-defined agent mode: injects `prompt` into the system prompt and (optionally) restricts the offered tools. */
export interface CustomMode {
  /** Stable slug id ([a-z0-9-]{1,32}) — unique, must not collide with built-in modes. */
  id: string;
  /** Display name (any language). */
  name: string;
  /** Single emoji shown in the mode selector. */
  icon: string;
  /** Mode instructions injected as a system-prompt section. */
  prompt: string;
  /** Optional tool whitelist — empty/undefined means all tools are offered. */
  tools?: string[];
}

/** Live status of one delegate_task subagent — streamed to the chat via the tool message. */
export interface SubtaskInfo {
  id: string;
  goal: string;
  role: string;
  status: 'running' | 'done' | 'failed';
  iterations?: number;
  durationMs?: number;
  /** Truncated final answer when done. */
  answer?: string;
  error?: string;
}

export interface ModeSwitchRequest {
  mode: AgentMode;
  reason: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface ChatHistoryEntry {
  id: string;
  title: string;
  /** True when the user manually renamed the chat — auto-titling must not override it. */
  titleCustom?: boolean;
  ts: number;
  messages: ChatMessage[];
  model: string;
  /** Pinned chats sort first in the history panel. */
  pinned?: boolean;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  ts: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  approvalState?: 'pending' | 'approved' | 'rejected' | 'auto-approved' | 'error';
  error?: string;
  pending?: boolean;
  /** Hermes-style reasoning/thinking content extracted from the assistant response. */
  reasoning?: string;
  /** Skills invoked during this message (for UI rendering). */
  skillsUsed?: string[];
  /** Attached images as data URLs (data:image/*;base64,…) — vision input for user messages. */
  images?: string[];
  /** delegate_task subagent board state for this tool message. */
  subtasks?: SubtaskInfo[];
  /** Token usage + estimated cost reported for this assistant turn. */
  usage?: TokenUsage;
  /** Generation speed for this assistant turn (completion tokens per second, 1-decimal) — Kilo-style "102.6 t/s" action-row chip. */
  tokensPerSec?: number;
  /** Kilo-style "+added -removed" line stats for file-mutating tools, computed host-side pre-execution. */
  diffStats?: { added: number; removed: number };
}

/** Per-turn token usage captured from the API (or estimated) + USD cost. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Estimated USD cost — omitted when the model's pricing is unknown. */
  costUsd?: number;
}

/** A pre-edit workspace snapshot the user can restore (Cline-style checkpoints). */
export interface CheckpointMeta {
  id: string;
  ts: number;
  /** Human label, e.g. "write_to_file · src/app.ts". */
  label: string;
  /** Relative paths captured in this snapshot. */
  files: string[];
}

/** Strip a leading agent-mode tag like "[PLAN MODE] " that the UI prepends. */
export function stripModeTag(text: string): string {
  return text.replace(/^\s*\[(PLAN|ASK|DEBUG|AUTO|CODING)\s+MODE\]\s*/i, '');
}

/** Build the leading agent-mode tag for an outgoing message. */
export function buildModeTag(mode: AgentMode): string {
  return mode !== 'coding' ? `[${mode.toUpperCase()} MODE] ` : '';
}

export type ToolCategory =
  | 'file'
  | 'terminal'
  | 'mcp'
  | 'web'
  | 'search'
  | 'git'
  | 'editor'
  | 'reasoning'
  | 'skill'
  | 'meta';

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  requiresApproval: boolean;
  readOnly?: boolean;
  /** Tags for skill routing and discoverability. */
  tags?: string[];
  /** Optional: hide this tool from the LLM's tool list but keep it callable (internal). */
  hidden?: boolean;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string; // human readable, Persian
  ts: number;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

export type ThemeBehavior = 'auto' | 'dark' | 'light';
export type UIStyle = 'default' | 'neomorphism';
export type StartupView = 'last-chat' | 'home';
export type ContextCompression = 'auto' | 'manual';

/**
 * MCP server configuration.
 *
 * Two transports are supported:
 *  - `stdio`   — legacy form: spawn `command` with `args`/`env`.
 *  - `http`    — streamable HTTP: POST JSON-RPC to `url`, auth via `headers`
 *                (matches the `{ mcpServers: { name: { url, headers } } }`
 *                JSON format used by standard MCP clients).
 */
export interface McpServerConfig {
  name: string;
  /** For stdio servers. Omitted for HTTP (url) servers. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable-HTTP endpoint, e.g. https://21st.dev/api/mcp */
  url?: string;
  /** Auth/custom headers sent with every HTTP request, e.g. { "x-api-key": "…" } */
  headers?: Record<string, string>;
  /** Inferred automatically from the presence of `url`. */
  transport?: 'http' | 'stdio';
  enabled?: boolean;
}

export interface ModelChoice {
  id: string;
  label: string;
  description: string;
  outputCost: number;
}

/**
 * A Skill is a higher-level reusable prompt pattern that the agent can invoke.
 * It wraps a multi-step procedure with explicit preconditions, required tools,
 * and a step-by-step body. Inspired by Hermes Agent's skills system.
 */
export interface SkillDefinition {
  name: string;
  description: string; // ≤60 chars, used in the LLM-facing skills list
  category: 'debug' | 'refactor' | 'test' | 'explain' | 'plan' | 'general';
  /** Tools that must be available for this skill to be invocable. */
  requiredTools?: string[];
  /** Markdown body of the skill — injected into the prompt when invoked. */
  body: string;
  /** Example user phrasings that should trigger this skill. */
  triggers?: string[];
  /** Where the skill came from — builtin bundle or installed from GitHub. */
  source?: SkillSource;
  /** Original GitHub URL for skills installed from a repo. */
  repoUrl?: string;
}

export type SkillSource = 'builtin' | 'github';

// ---- Webview ↔ Host message protocol ----

export type WebviewToHostMessage =
  | { type: 'SEND_MESSAGE'; text: string; images?: string[] }
  | { type: 'CANCEL' }
  | { type: 'APPROVE'; requestId: string; approved: boolean; reason?: string }
  | { type: 'NEW_CHAT' }
  | { type: 'SWITCH_MODEL'; modelId: string }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'GET_STATE' }
  | { type: 'SAVE_API_KEY'; apiKey: string }
  | { type: 'LIST_MCP_SERVERS' }
  | { type: 'ADD_MCP_SERVER'; server: McpServerConfig }
  | { type: 'REMOVE_MCP_SERVER'; name: string }
  | { type: 'TEST_MCP_SERVER'; name: string }
  | { type: 'GET_MCP_TOOLS'; name?: string }
  | { type: 'LOAD_CHAT'; chatId: string }
  | { type: 'DELETE_CHAT'; chatId: string }
  | { type: 'GET_HISTORY' }
  | { type: 'MODE_SWITCH_RESPONSE'; approved: boolean; reason?: string }
  | { type: 'GET_SKILLS' }
  | { type: 'INVOKE_SKILL'; name: string; args?: Record<string, unknown> }
  | { type: 'SET_AGENT_MODE'; mode: AgentMode }
  /** Upsert a user-defined mode (id is the key). */
  | { type: 'SAVE_CUSTOM_MODE'; mode: CustomMode }
  /** Delete a user-defined mode by id; switching back to 'coding' if it was active. */
  | { type: 'DELETE_CUSTOM_MODE'; id: string }
  | { type: 'SET_AUTO_APPROVE_MODE'; mode: AutoApproveMode }
  | { type: 'SET_CONFIG'; key: string; value: unknown }
  | { type: 'RENAME_CHAT'; chatId: string; title: string }
  | { type: 'IMPROVE_PROMPT'; text: string }
  /** Re-send an edited user message: truncates host history at the original and re-runs. */
  | { type: 'EDIT_USER_MESSAGE'; previousText: string; newText: string; mode: AgentMode }
  /** Re-run the last user prompt: host truncates history at that prompt (dropping the old answer) and re-runs. */
  | { type: 'REGENERATE' }
  | { type: 'GET_TOOL_LIST' }
  /** Persist the full providers array (Providers tab → settings.json). */
  | { type: 'SET_PROVIDERS'; providers: ProviderConfig[] }
  /** Persist per-mode model assignments (Models tab → settings.json). */
  | { type: 'SET_MODEL_ASSIGNMENTS'; assignments: Record<AgentMode, string> }
  /**
   * Test a provider connection. `provider` carries the CURRENT DRAFT entry so
   * the test reflects unsaved edits; when omitted the host resolves the
   * providerId from the saved configuration.
   */
  | { type: 'TEST_PROVIDER_CONNECTION'; providerId: string; provider?: ProviderConfig }
  | { type: 'ADD_SKILL_FROM_GITHUB'; url: string }
  | { type: 'REMOVE_CUSTOM_SKILL'; name: string }
  | { type: 'RESET_SETTINGS' }
  | { type: 'EXPORT_SETTINGS' }
  | { type: 'IMPORT_SETTINGS'; data: string }
  /** Open a vscode.diff for a pending file-edit approval (before vs after). */
  | { type: 'OPEN_DIFF'; requestId: string }
  /** Re-open the official VS Code diff editor for a completed file-mutating tool call. */
  | { type: 'OPEN_TOOL_DIFF'; messageId: string }
  /** Restore a checkpoint snapshot (Cline-style undo). */
  | { type: 'RESTORE_CHECKPOINT'; checkpointId: string }
  /** Summarize + compact the current conversation in place. */
  | { type: 'CONDENSE_CONTEXT' }
  /** Export the current chat as a Markdown file (save dialog). */
  | { type: 'EXPORT_CHAT' }
  /** Branch a new chat from an existing assistant message. */
  | { type: 'FORK_CHAT'; messageId: string }
  /** Pin/unpin a history entry (pinned entries sort first). */
  | { type: 'SET_HISTORY_PIN'; id: string; pinned: boolean }
  /** Fuzzy workspace file search for @-mention autocomplete. */
  | { type: 'SEARCH_WORKSPACE_FILES'; query: string };

export type HostToWebviewMessage =
  | { type: 'STATE'; state: AgentState }
  | { type: 'MESSAGE_APPEND'; message: ChatMessage }
  | { type: 'MESSAGE_UPDATE'; message: ChatMessage }
  | { type: 'MESSAGE_REMOVE'; id: string }
  | { type: 'APPROVAL_REQUEST'; request: ApprovalRequest }
  | { type: 'APPROVAL_RESOLVED'; id: string; approved: boolean }
  | { type: 'TOOL_START'; message: ChatMessage }
  | { type: 'TOOL_END'; message: ChatMessage }
  | { type: 'ERROR'; message: string }
  | { type: 'MODELS'; models: ModelChoice[]; current: string }
  | { type: 'MCP_SERVERS'; servers: McpServerConfig[] }
  | { type: 'MCP_TOOLS'; tools: Array<{ server: string; name: string; description?: string }> }
  | { type: 'CONFIG'; config: AgentConfig }
  | { type: 'HISTORY'; entries: Array<{ id: string; title: string; ts: number; messageCount: number; model: string; pinned?: boolean; snippet?: string }> }
  | { type: 'TODOS_UPDATE'; todos: TodoItem[] }
  | { type: 'MODE_SWITCH_REQUEST'; request: ModeSwitchRequest | null }
  | { type: 'SKILLS'; skills: Array<{ name: string; description: string; category: string; source?: SkillSource; repoUrl?: string }> }
  | { type: 'THEME_CHANGE'; theme: 'dark' | 'light' | 'high-contrast' }
  | { type: 'IMPROVED_PROMPT'; original: string; improved: string }
  | { type: 'TOOL_LIST'; tools: Array<{ name: string; category: ToolCategory; readOnly: boolean; requiresApproval: boolean }> }
  | { type: 'PROVIDER_TEST_RESULT'; providerId: string; ok: boolean; error?: string }
  | { type: 'SKILL_INSTALL_RESULT'; ok: boolean; name?: string; error?: string }
  | { type: 'SETTINGS_EXPORT'; data: string }
  /** Before/after payloads backing an approval's inline diff preview + Open Diff. */
  | { type: 'APPROVAL_DIFF_DATA'; requestId: string; path: string; before: string; after: string }
  /** Emitted right after a checkpoint snapshot is captured (attach to last assistant msg). */
  | { type: 'CHECKPOINT'; checkpoint: CheckpointMeta }
  /** Result of restoring a checkpoint. */
  | { type: 'CHECKPOINT_RESTORED'; checkpointId: string; restored: number; errors?: string[] }
  /** Result of CONDENSE_CONTEXT. */
  | { type: 'CONDENSE_RESULT'; ok: boolean; beforeTokens?: number; afterTokens?: number; error?: string }
  /** Result of EXPORT_CHAT. */
  | { type: 'EXPORT_RESULT'; ok: boolean; path?: string; error?: string }
  /** Result of FORK_CHAT. */
  | { type: 'FORK_CREATED'; chatId: string }
  /** Workspace file matches for @-mention autocomplete. */
  | { type: 'WORKSPACE_FILES'; files: string[] };

export interface AgentConfig {
  /** Extension version shown in the webview header. */
  version?: string;
  apiKeySet: boolean;
  baseURL: string;
  defaultModel: string;
  professionalModel: string;
  language: 'fa' | 'en';
  enableMCP: boolean;
  autoApproveMode: AutoApproveMode;
  maxIterations: number;
  /** When true, the agent uses the Hermes chat template format for tool calls. */
  hermesMode: boolean;
  /** When true, the model's reasoning/thinking channel is shown in the UI. */
  showReasoning: boolean;
  /** When true, independent tool calls are executed concurrently. */
  parallelToolCalls: boolean;
  /** Per-mode model assignments. */
  modelAssignments?: Record<AgentMode, string>;
  /** Provider configurations. */
  providers?: ProviderConfig[];
  // General section
  themeBehavior?: ThemeBehavior;
  uiStyle?: UIStyle;
  startupView?: StartupView;
  notifyOnTaskComplete?: boolean;
  // Permissions section
  toolOverrides?: Record<string, boolean>;
  // Advanced section
  contextCompression?: ContextCompression;
  historyPath?: string;
  /** Optional UI hint: the model's context window size (tokens). */
  contextLimit?: number;
  /** Estimated system-prompt size in tokens (ContextBar breakdown). */
  systemTokens?: number;
  /** Estimated tool-definitions size in tokens (ContextBar breakdown). */
  toolsTokens?: number;
  /** After each file edit, collect VS Code diagnostics and feed errors back to the loop. */
  autoDiagnostics?: boolean;
  /** User-defined agent modes (Settings → Modes). */
  customModes?: CustomMode[];
  /** When true, a compact repository symbol outline is injected into the system prompt. */
  repoMap?: boolean;
  /** When true, inline ghost-text completions are enabled (opt-in, costs API calls). */
  ghostText?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: ModelChoice[];
  enabled: boolean;
}

export interface AgentState {
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  isBusy: boolean;
  currentModel: string;
  models: ModelChoice[];
  config: AgentConfig;
  mcpServers: McpServerConfig[];
}
