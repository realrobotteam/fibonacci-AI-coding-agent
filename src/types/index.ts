// Shared types between extension host and webview.
// Keep this file dependency-free so it can be imported from both sides.

export type Role = 'user' | 'assistant' | 'system' | 'tool' | 'developer';

export type AgentMode = 'coding' | 'plan' | 'ask' | 'debug' | 'auto';

export type AutoApproveMode = 'none' | 'read-only' | 'all';

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
  ts: number;
  messages: ChatMessage[];
  model: string;
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
export type StartupView = 'last-chat' | 'home';
export type ContextCompression = 'auto' | 'manual';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
}

// ---- Webview ↔ Host message protocol ----

export type WebviewToHostMessage =
  | { type: 'SEND_MESSAGE'; text: string }
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
  | { type: 'SET_AUTO_APPROVE_MODE'; mode: AutoApproveMode }
  | { type: 'SET_CONFIG'; key: string; value: unknown }
  | { type: 'RENAME_CHAT'; chatId: string; title: string }
  | { type: 'IMPROVE_PROMPT'; text: string }
  | { type: 'GET_TOOL_LIST' }
  | { type: 'TEST_PROVIDER_CONNECTION'; providerId: string }
  | { type: 'RESET_SETTINGS' }
  | { type: 'EXPORT_SETTINGS' }
  | { type: 'IMPORT_SETTINGS'; data: string };

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
  | { type: 'HISTORY'; entries: Array<{ id: string; title: string; ts: number; messageCount: number; model: string }> }
  | { type: 'TODOS_UPDATE'; todos: TodoItem[] }
  | { type: 'MODE_SWITCH_REQUEST'; request: ModeSwitchRequest }
  | { type: 'SKILLS'; skills: Array<{ name: string; description: string; category: string }> }
  | { type: 'THEME_CHANGE'; theme: 'dark' | 'light' | 'high-contrast' }
  | { type: 'IMPROVED_PROMPT'; original: string; improved: string }
  | { type: 'TOOL_LIST'; tools: Array<{ name: string; category: ToolCategory; readOnly: boolean; requiresApproval: boolean }> }
  | { type: 'PROVIDER_TEST_RESULT'; providerId: string; ok: boolean; error?: string }
  | { type: 'SETTINGS_EXPORT'; data: string };

export interface AgentConfig {
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
  startupView?: StartupView;
  notifyOnTaskComplete?: boolean;
  // Permissions section
  toolOverrides?: Record<string, boolean>;
  // Advanced section
  contextCompression?: ContextCompression;
  historyPath?: string;
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
