import React from 'react';
import type { ChatMessage } from '@shared/index';
import { useStore } from '../store/useStore';
import { Markdown } from './Markdown';
import { FibonacciLogo } from './Header';

const TOOL_LABELS: Record<string, string> = {
  read_file: 'tool.readFile',
  write_to_file: 'tool.writeFile',
  replace_in_file: 'tool.replaceInFile',
  list_files: 'tool.listFiles',
  search_files: 'tool.searchFiles',
  get_active_editor: 'tool.getActiveEditor',
  execute_command: 'tool.executeCommand',
  run_in_terminal: 'tool.runInTerminal',
  get_command_output: 'tool.getCommandOutput',
  list_mcp_tools: 'tool.listMcpTools',
  call_mcp_tool: 'tool.callMcpTool',
  get_mcp_resources: 'tool.getMcphesources',
  manage_mcp_servers: 'tool.manageMcpServers',
  insert_at_line: 'tool.insertAtLine',
  delete_lines: 'tool.deleteLines',
  append_to_file: 'tool.appendToFile',
  grep_search: 'tool.grepSearch',
  glob_files: 'tool.globFiles',
  web_fetch: 'tool.webFetch',
  web_search: 'tool.webSearch',
  git_status: 'tool.gitStatus',
  git_diff: 'tool.gitDiff',
  git_log: 'tool.gitLog',
  diagnostics: 'tool.diagnostics',
  format_code: 'tool.formatCode',
  document_symbols: 'tool.documentSymbols',
  workspace_symbols: 'tool.workspaceSymbols',
  code_actions: 'tool.codeActions',
  open_file: 'tool.openFile',
  think: 'tool.think',
  list_skills: 'tool.listSkills',
  view_skill: 'tool.viewSkill',
  invoke_skill: 'tool.invokeSkill',
  delegate_task: 'tool.delegateTask',
  execute_code: 'tool.executeCode',
  memory: 'tool.memory',
};

function getToolTarget(toolName: string, args: Record<string, unknown>): string {
  if (!args) return '';
  switch (toolName) {
    case 'read_file':
    case 'write_to_file':
    case 'replace_in_file':
    case 'insert_at_line':
    case 'delete_lines':
    case 'append_to_file':
    case 'format_code':
    case 'document_symbols':
    case 'code_actions':
    case 'open_file':
      return String(args.path ?? '');
    case 'list_files':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return args.path ? String(args.path) : '';
    case 'search_files':
    case 'grep_search':
    case 'web_search':
    case 'workspace_symbols':
      return args.query || args.pattern ? `"${String(args.query ?? args.pattern ?? '')}"` : '';
    case 'glob_files':
      return args.pattern ? String(args.pattern) : '';
    case 'web_fetch':
      return args.url ? String(args.url) : '';
    case 'get_active_editor':
      return '';
    case 'execute_command':
    case 'run_in_terminal':
      return String(args.command ?? '').split(' ').slice(0, 3).join(' ');
    case 'call_mcp_tool':
      return args.server ? `${args.server}/${args.tool ?? ''}` : '';
    case 'list_mcp_tools':
    case 'get_mcp_resources':
      return args.server ? String(args.server) : '';
    case 'manage_mcp_servers':
      return args.action ? String(args.action) : '';
    case 'list_skills':
    case 'view_skill':
    case 'invoke_skill':
      return args.name ? String(args.name) : '';
    case 'think':
      return '';
    case 'diagnostics':
      return args.path ? String(args.path) : '';
    case 'delegate_task': {
      const tasks = (args.tasks as unknown[]) ?? [];
      return `${tasks.length}`;
    }
    case 'execute_code':
      return String(args.language ?? 'python3');
    case 'memory': {
      const ops = (args.operations as unknown[]) ?? [];
      return `${ops.length}`;
    }
    default:
      return '';
  }
}

/** Copy to clipboard with feedback */
function useCopyFeedback() {
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const copy = React.useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch { /* clipboard unavailable */ }
  }, []);
  return { copiedId, copy };
}

/* ── Main MessageBubble ── */

export const MessageBubble: React.FC<{
  message: ChatMessage;
  isLastAssistant?: boolean;
}> = ({ message, isLastAssistant }) => {
  if (message.role === 'tool') {
    return <ToolBlock message={message} />;
  }

  const isUser = message.role === 'user';

  return (
    <div className={`group/msg animate-slide-up ${isUser ? 'user-msg' : 'assistant-msg'}`}>
      {/* Avatar + name for assistant */}
      {!isUser && (
        <div className="flex items-center gap-1.5 mb-1">
          <FibonacciLogo className="w-3.5 h-3.5" />
          <span className="text-2xs font-semibold text-text-tertiary">Fibonacci</span>
        </div>
      )}

      {/* Content */}
      <div className={isUser ? '' : 'mr-4'}>
        {/* Reasoning */}
        {!isUser && message.reasoning && message.reasoning.trim().length > 0 && (
          <ReasoningBlock reasoning={message.reasoning} />
        )}

        {message.content ? (
          isUser ? (
            <UserContent content={message.content} messageId={message.id} />
          ) : (
            <AssistantContent content={message.content} messageId={message.id} isLast={!!isLastAssistant} />
          )
        ) : message.pending ? (
          <TypingIndicator />
        ) : null}
      </div>
    </div>
  );
};

/* ── User message ── */

const UserContent: React.FC<{ content: string; messageId: string }> = ({ content, messageId }) => {
  const t = useStore((s) => s.t);
  const startEdit = useStore((s) => s.startEdit);
  const { copiedId, copy } = useCopyFeedback();

  return (
    <div className="bg-brand/8 border border-brand/15 rounded-md px-2.5 py-1.5">
      <div className="text-[13px] text-text-primary whitespace-pre-wrap leading-relaxed">{content}</div>
      <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
        <MsgBtn
          title={copiedId === messageId ? t('common.copied') : t('common.copy')}
          onClick={() => copy(messageId, content)}
        >
          {copiedId === messageId ? <IconCheck /> : <IconCopy />}
        </MsgBtn>
        <MsgBtn title={t('common.edit')} onClick={() => startEdit(content)}>
          <IconEdit />
        </MsgBtn>
      </div>
    </div>
  );
};

/* ── Assistant message ── */

const AssistantContent: React.FC<{
  content: string;
  messageId: string;
  isLast: boolean;
}> = ({ content, messageId, isLast }) => {
  const t = useStore((s) => s.t);
  const regenerate = useStore((s) => s.regenerateLastMessage);
  const isBusy = useStore((s) => s.isBusy);
  const { copiedId, copy } = useCopyFeedback();

  return (
    <div>
      <Markdown content={content} />
      <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
        <MsgBtn
          title={copiedId === messageId ? t('common.copied') : t('common.copy')}
          onClick={() => copy(messageId, content)}
        >
          {copiedId === messageId ? <IconCheck /> : <IconCopy />}
        </MsgBtn>
        {isLast && !isBusy && (
          <MsgBtn title={t('chat.regenerate')} onClick={regenerate}>
            <IconRefresh />
          </MsgBtn>
        )}
      </div>
    </div>
  );
};

/* ── Message action button ── */

const MsgBtn: React.FC<{
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    className="w-5 h-5 flex items-center justify-center rounded-sm text-text-muted hover:text-text-secondary hover:bg-hover transition-all duration-fast"
  >
    {children}
  </button>
);

/* ── Typing indicator ── */

const TypingIndicator = () => (
  <div className="flex items-center gap-1 py-1">
    <span className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-dot" />
    <span className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-dot" style={{ animationDelay: '0.2s' }} />
    <span className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-dot" style={{ animationDelay: '0.4s' }} />
  </div>
);

/* ── Reasoning block ── */

const ReasoningBlock: React.FC<{ reasoning: string }> = ({ reasoning }) => {
  const [expanded, setExpanded] = React.useState(false);
  const preview = reasoning.slice(0, 60).replace(/\n/g, ' ');

  return (
    <div className="mb-1.5 border border-border-subtle rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-2xs text-text-tertiary hover:bg-hover transition-colors"
      >
        <svg
          className={`w-2.5 h-2.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="font-medium">{reasoning.length > 0 ? 'thinking' : ''}</span>
        {!expanded && preview && (
          <span className="truncate text-text-muted" dir="ltr">
            {preview}{reasoning.length > 60 ? '...' : ''}
          </span>
        )}
      </button>
      {expanded && (
        <pre
          className="text-2xs text-text-secondary whitespace-pre-wrap px-2 py-1.5 border-t border-border-subtle bg-elevated max-h-48 overflow-y-auto"
          dir="ltr"
        >
          {reasoning}
        </pre>
      )}
    </div>
  );
};

/* ── Tool block (compact activity line) ── */

const ToolBlock: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const t = useStore((s) => s.t);
  const expanded = useStore((s) => s.expandedToolIds[message.id]);
  const toggle = useStore((s) => s.toggleToolExpanded);
  const labelKey = TOOL_LABELS[message.toolName ?? ''] ?? 'tool.executing';
  const category = inferCategory(message.toolName);
  const target = getToolTarget(message.toolName ?? '', message.toolArgs ?? {});

  return (
    <div className="animate-slide-up">
      <button
        onClick={() => toggle(message.id)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-2xs bg-elevated/50 hover:bg-elevated border border-border-subtle rounded-md transition-colors duration-fast text-right"
      >
        <ToolIcon category={category} toolName={message.toolName} />
        <span className="text-text-secondary font-medium shrink-0">{t(labelKey)}</span>
        {target && (
          <span className="text-text-muted truncate flex-1 text-left" dir="ltr">{target}</span>
        )}
        <ToolStatus message={message} />
        <svg
          className={`w-2.5 h-2.5 text-text-muted transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {expanded && message.toolResult !== undefined && (
        <div className="mt-1 border border-border-subtle rounded-md bg-panel overflow-hidden">
          <div className="px-2 py-1">
            <pre
              className="text-2xs text-text-secondary overflow-x-auto whitespace-pre-wrap bg-elevated rounded p-1.5 border border-border-subtle max-h-40 overflow-y-auto"
              dir="ltr"
            >
              {(message.toolResult || '(empty)').slice(0, 3000)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

/* ── Tool status badge ── */

const ToolStatus: React.FC<{ message: ChatMessage }> = ({ message }) => {
  if (message.pending) {
    return <span className="w-1.5 h-1.5 bg-status-warning rounded-full animate-pulse-dot" />;
  }
  const s = message.approvalState;
  if (s === 'approved' || s === 'auto-approved') {
    return <span className="text-status-success text-2xs">✓</span>;
  }
  if (s === 'rejected') {
    return <span className="text-status-error text-2xs">✕</span>;
  }
  if (s === 'error') {
    return <span className="text-status-error text-2xs">!</span>;
  }
  return null;
};

/* ── Tool icon by category ── */

const ToolIcon: React.FC<{ category: string; toolName?: string }> = ({ category, toolName }) => {
  const cls = 'w-3 h-3 shrink-0';

  // File read
  if (['read_file', 'list_files', 'search_files', 'grep_search', 'glob_files', 'document_symbols', 'workspace_symbols', 'diagnostics', 'open_file'].includes(toolName ?? '')) {
    return <svg className={`${cls} text-file-read`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>;
  }
  // File write
  if (['write_to_file', 'replace_in_file', 'insert_at_line', 'delete_lines', 'append_to_file', 'format_code'].includes(toolName ?? '')) {
    return <svg className={`${cls} text-file-write`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>;
  }
  // Terminal
  if (category === 'terminal') {
    return <svg className={`${cls} text-terminal`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>;
  }
  // MCP
  if (category === 'mcp') {
    return <svg className={`${cls} text-mcp`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>;
  }
  // Web
  if (category === 'web') {
    return <svg className={`${cls} text-web`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
  }
  // Git
  if (category === 'git') {
    return <svg className={`${cls} text-git`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" /></svg>;
  }
  // Reasoning
  if (category === 'reasoning') {
    return <svg className={`${cls} text-reasoning`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>;
  }
  // Skill
  if (category === 'skill') {
    return <svg className={`${cls} text-skill`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>;
  }
  // Default
  return <svg className={`${cls} text-default`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>;
};

function inferCategory(toolName?: string): string {
  if (!toolName) return 'file';
  if (toolName.startsWith('mcp_') || ['list_mcp_tools', 'call_mcp_tool', 'get_mcp_resources', 'manage_mcp_servers'].includes(toolName)) return 'mcp';
  if (['execute_command', 'run_in_terminal', 'get_command_output'].includes(toolName)) return 'terminal';
  if (['web_fetch', 'web_search'].includes(toolName)) return 'web';
  if (['git_status', 'git_diff', 'git_log'].includes(toolName)) return 'git';
  if (['think'].includes(toolName)) return 'reasoning';
  if (['list_skills', 'view_skill', 'invoke_skill'].includes(toolName)) return 'skill';
  return 'file';
}

/* ── Icon components ── */

const IconCopy = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const IconCheck = () => (
  <svg className="w-3 h-3 text-status-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const IconEdit = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const IconRefresh = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);
