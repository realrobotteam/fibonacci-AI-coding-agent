import { create } from 'zustand';
import type {
  AgentConfig,
  AgentMode,
  AgentState,
  ApprovalRequest,
  ChatMessage,
  McpServerConfig,
  ModeSwitchRequest,
  ModelChoice,
  TodoItem,
} from '@shared/index';
import { Locale, translate } from '../i18n/translations';

interface UIState {
  activeTab: 'chat' | 'settings';
  expandedToolIds: Record<string, boolean>;
  draftApiKey: string;
  isBusy: boolean;
}

export interface HistoryEntry {
  id: string;
  title: string;
  ts: number;
  messageCount: number;
  model: string;
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
  todos: TodoItem[];
  modeSwitchRequest: ModeSwitchRequest | null;
  skills: Array<{ name: string; description: string; category: string }>;

  // actions
  setActiveTab: (tab: 'chat' | 'settings') => void;
  setAgentMode: (mode: AgentMode) => void;
  setTodos: (todos: TodoItem[]) => void;
  setModeSwitchRequest: (req: ModeSwitchRequest | null) => void;
  toggleToolExpanded: (id: string) => void;
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
  t: (key: string, fallback?: string) => string;
}

const initialConfig: AgentConfig | null = null;

export const useStore = create<Store>((set, get) => ({
  activeTab: 'chat',
  expandedToolIds: {},
  draftApiKey: '',
  isBusy: false,
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
  todos: [],
  modeSwitchRequest: null,
  skills: [],

  setActiveTab: (tab) => set({ activeTab: tab }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setTodos: (todos) => set({ todos }),
  setModeSwitchRequest: (req) => set({ modeSwitchRequest: req }),
  toggleToolExpanded: (id) =>
    set((s) => ({ expandedToolIds: { ...s.expandedToolIds, [id]: !s.expandedToolIds[id] } })),
  setDraftApiKey: (key) => set({ draftApiKey: key }),
  setError: (msg) => set({ lastError: msg }),
  setLocale: (l) => set({ locale: l }),
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
    }),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (m) =>
    set((s) => ({ messages: s.messages.map((x) => (x.id === m.id ? m : x)) })),
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
    set({ config, locale: (config.language as Locale) ?? 'fa' }),
  setMcpServers: (servers) => set({ mcpServers: servers }),
  setHistory: (entries) => set({ history: entries }),
  setSkills: (skills) => set({ skills }),
  t: (key, fallback) => translate(get().locale, key, fallback),
}));
