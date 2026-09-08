import { create } from 'zustand';
import type {
  AgentConfig,
  AgentMode,
  AgentState,
  ApprovalRequest,
  AutoApproveMode,
  ChatMessage,
  CheckpointMeta,
  McpServerConfig,
  ModeSwitchRequest,
  ModelChoice,
  TodoItem,
  ToolCategory,
} from '@shared/index';
import { Locale, translate } from '../i18n/translations';
import { postMessage } from '../vscodeApi';

interface UIState {
  activeTab: 'chat' | 'settings';
  expandedToolIds: Record<string, boolean>;
  draftApiKey: string;
  isBusy: boolean;
  editingText: string | null;
  /** Pending composer text (home-page example chips → InputArea). Consumed once. */
  composerDraft: string | null;
}

export interface HistoryEntry {
  id: string;
  title: string;
  ts: number;
  messageCount: number;
  model: string;
  /** Pinned chats sort first in the history panel. */
  pinned?: boolean;
  /** First user-message excerpt, used by history search. */
  snippet?: string;
}

export interface ToolListItem {
  name: string;
  category: ToolCategory;
  readOnly: boolean;
  requiresApproval: boolean;
  /** Present on host ToolDefinition; used by PermissionsSection filtering. */
  hidden?: boolean;
}

interface Store extends UIState {
  messages: ChatMessage[];
  pendingApprovals: ApprovalRequest[];
  currentModel: string;
  models: ModelChoice[];
  config: AgentConfig | null;
  mcpServers: McpServerConfig[];
  lastError: string | null;
  locale: Locale;
  history: HistoryEntry[];
  agentMode: AgentMode;
  autoApproveMode: AutoApproveMode;
  todos: TodoItem[];
  modeSwitchRequest: ModeSwitchRequest | null;
  skills: Array<{ name: string; description: string; category: string }>;
  toolList: ToolListItem[];
  /** Before/after payloads backing approval inline diff previews, by request id. */
  approvalDiffs: Record<string, { path: string; before: string; after: string }>;
  /** Checkpoint metadata keyed by the assistant message id it belongs to. */
  checkpoints: Record<string, CheckpointMeta>;
  /** True while a CONDENSE_CONTEXT round-trip is in flight. */
  condensing: boolean;
  /** Workspace file paths for @-mention autocomplete. */
  workspaceFiles: string[];
  /** Lightweight toast; auto-dismissed by the renderer (see App.tsx). */
  notice: { text: string; ts: number } | null;

  // actions
  setActiveTab: (tab: 'chat' | 'settings') => void;
  setAgentMode: (mode: AgentMode) => void;
  setAutoApproveMode: (mode: AutoApproveMode) => void;
  setTodos: (todos: TodoItem[]) => void;
  setModeSwitchRequest: (req: ModeSwitchRequest | null) => void;
  toggleToolExpanded: (id: string) => void;
  startEdit: (text: string) => void;
  cancelEdit: () => void;
  setEditingText: (text: string) => void;
  setComposerDraft: (text: string | null) => void;
  regenerateLastMessage: () => void;
  setDraftApiKey: (key: string) => void;
  setError: (msg: string | null) => void;
  setLocale: (l: Locale) => void;
  hydrateFromState: (state: AgentState) => void;
  appendMessage: (m: ChatMessage) => void;
  updateMessage: (m: ChatMessage) => void;
  removeMessage: (id: string) => void;
  addApproval: (req: ApprovalRequest) => void;
  resolveApproval: (id: string, approved: boolean) => void;
  setModels: (models: ModelChoice[], current: string) => void;
  setConfig: (config: AgentConfig) => void;
  setMcpServers: (s: McpServerConfig[]) => void;
  setHistory: (entries: HistoryEntry[]) => void;
  setSkills: (skills: Array<{ name: string; description: string; category: string }>) => void;
  setToolList: (tools: ToolListItem[]) => void;
  setApprovalDiff: (requestId: string, diff: { path: string; before: string; after: string }) => void;
  attachCheckpoint: (meta: CheckpointMeta) => void;
  setCondensing: (v: boolean) => void;
  setWorkspaceFiles: (files: string[]) => void;
  setNotice: (text: string | null) => void;
  t: (key: string, fallback?: string) => string;
}

const initialConfig: AgentConfig | null = null;

// FIX (locale switch not re-rendering): the previous implementation created
// the `t` function once, so its reference never changed and components that
// selected only `s.t` never re-rendered when the locale changed. We now
// re-create `t` whenever the locale is set.
const makeT = (locale: Locale) => (key: string, fallback?: string) =>
  translate(locale, key, fallback);

export const useStore = create<Store>((set) => ({
  activeTab: 'chat',
  expandedToolIds: {},
  draftApiKey: '',
  isBusy: false,
  editingText: null,
  composerDraft: null,
  messages: [],
  pendingApprovals: [],
  currentModel: 'fibonacci-1-pro-max',
  models: [],
  config: initialConfig,
  mcpServers: [],
  lastError: null,
  locale: 'fa',
  history: [],
  agentMode: 'coding',
  autoApproveMode: 'none',
  todos: [],
  modeSwitchRequest: null,
  skills: [],
  toolList: [],
  approvalDiffs: {},
  checkpoints: {},
  condensing: false,
  workspaceFiles: [],
  notice: null,
  t: makeT('fa'),

  setActiveTab: (tab) => set({ activeTab: tab }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setAutoApproveMode: (mode) => set({ autoApproveMode: mode }),
  setTodos: (todos) => set({ todos: Array.isArray(todos) ? todos : [] }), // FIX (e.filter crash): store-level gate
  setModeSwitchRequest: (req) => set({ modeSwitchRequest: req }),
  toggleToolExpanded: (id) =>
    set((s) => ({ expandedToolIds: { ...s.expandedToolIds, [id]: !s.expandedToolIds[id] } })),
  startEdit: (text) => set({ editingText: text }),
  cancelEdit: () => set({ editingText: null }),
  setEditingText: (text) => set({ editingText: text }),
  setComposerDraft: (text) => set({ composerDraft: text }),
  regenerateLastMessage: () => {
    // FIX (regenerate corrupted the conversation): the old implementation only
    // trimmed the webview's local message copy and re-posted SEND_MESSAGE, so
    // the host kept the previous answer and tool turns in its history and then
    // appended the user prompt a second time — the model saw a duplicated turn
    // plus a stale response. The host now owns the rewind: REGENERATE truncates
    // host history back to the last user prompt and re-runs it, then pushes a
    // fresh full state to the webview.
    postMessage({ type: 'REGENERATE' });
  },
  setDraftApiKey: (key) => set({ draftApiKey: key }),
  setError: (msg) => set({ lastError: msg }),
  setLocale: (l) => set({ locale: l, t: makeT(l) }),
  hydrateFromState: (state) =>
    set({
      messages: state.messages,
      pendingApprovals: state.pendingApprovals,
      isBusy: state.isBusy,
      currentModel: state.currentModel,
      models: state.models,
      config: state.config,
      mcpServers: state.mcpServers,
      locale: (state.config?.language as Locale) ?? 'fa',
      t: makeT((state.config?.language as Locale) ?? 'fa'),
      // Fresh chat load — drop per-message UI expansion state and the
      // per-chat diff/checkpoint caches.
      expandedToolIds: {},
      approvalDiffs: {},
      checkpoints: {},
      condensing: false,
      workspaceFiles: [],
      notice: null,
    }),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (m) =>
    set((s) => {
      const idx = s.messages.findIndex((x) => x.id === m.id);
      if (idx === -1) return { messages: [...s.messages, m] };
      const next = [...s.messages];
      next[idx] = m;
      return { messages: next };
    }),
  removeMessage: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  addApproval: (req) =>
    set((s) => ({
      // Avoid duplicates — if the same request id already exists, don't add again.
      pendingApprovals: s.pendingApprovals.some((p) => p.id === req.id)
        ? s.pendingApprovals
        : [...s.pendingApprovals, req],
    })),
  resolveApproval: (id, approved) =>
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.id !== id),
    })),
  setModels: (models, current) => set({ models, currentModel: current }),
  setConfig: (config) =>
    set({
      config,
      locale: (config.language as Locale) ?? 'fa',
      t: makeT((config.language as Locale) ?? 'fa'),
    }),
  setMcpServers: (servers) => set({ mcpServers: servers }),
  setHistory: (entries) => set({ history: entries }),
  setSkills: (skills) => set({ skills }),
  setToolList: (tools) => set({ toolList: tools }),
  setApprovalDiff: (requestId, diff) =>
    set((s) => ({ approvalDiffs: { ...s.approvalDiffs, [requestId]: diff } })),
  // Attach to the LAST assistant message currently in the list (search from
  // the end); drop silently when there is none.
  attachCheckpoint: (meta) =>
    set((s) => {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].role === 'assistant') {
          return { checkpoints: { ...s.checkpoints, [s.messages[i].id]: meta } };
        }
      }
      return {};
    }),
  setCondensing: (v) => set({ condensing: v }),
  setWorkspaceFiles: (files) => set({ workspaceFiles: files }),
  setNotice: (text) => set(text ? { notice: { text, ts: Date.now() } } : { notice: null }),
}));
