// Shared types between extension host and webview.
// Keep this file dependency-free so it can be imported from both sides.

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type AgentMode = 'coding' | 'plan';

export interface ModeSwitchRequest {
  mode: AgentMode;
  reason: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

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
}

export type ToolCategory = 'file' | 'terminal' | 'mcp';

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  requiresApproval: boolean;
  readOnly?: boolean;
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

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ModelChoice {
  id: string;
  label: string;
  description: string;
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
  | { type: 'MODE_SWITCH_RESPONSE'; approved: boolean; reason?: string };

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
  | { type: 'MODE_SWITCH_REQUEST'; request: ModeSwitchRequest };

export interface AgentConfig {
  apiKeySet: boolean;
  baseURL: string;
  defaultModel: string;
  professionalModel: string;
  language: 'fa' | 'en';
  enableMCP: boolean;
  autoApproveReadOnly: boolean;
  maxIterations: number;
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
