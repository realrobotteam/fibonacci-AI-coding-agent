import React from 'react';
import type { ChatMessage } from '@shared/index';
import { useStore } from '../store/useStore';
import { Markdown } from './Markdown';
import { FibonacciMascot } from './Header';

const TOOL_LABEL_KEYS: Record<string, string> = {
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
  // New tools
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

/**
 * Extract a human-readable target (file path, command, URL) from tool args
 * to display as part of the activity line, e.g. "reading index.html".
 */
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
      return '(current file)';
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
      return '(reasoning)';
    case 'diagnostics':
      return args.path ? String(args.path) : '(all files)';
    case 'delegate_task': {
      const tasks = (args.tasks as unknown[]) ?? [];
      return `${tasks.length} subagent${tasks.length === 1 ? '' : 's'}`;
    }
    case 'execute_code':
      return `${args.language ?? 'python3'} (${(args.script as string ?? '').length} chars)`;
    case 'memory': {
      const ops = (args.operations as unknown[]) ?? [];
      return `${ops.length} op${ops.length === 1 ? '' : 's'}`;
    }
    default:
      return '';
  }
}

export const MessageBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  if (message.role === 'tool') {
    return <ToolBlock message={message} />;
  }

  const isUser = message.role === 'user';
  return (
    <div
      className={`animate-slide-up ${
        isUser
          ? 'border-r-2 border-brand bg-input/40 rounded-l-card pr-3 py-2'
          : 'py-1'
      }`}
    >
      {!isUser && (
        <div className="flex items-center gap-1.5 mb-1">
          <FibonacciMascot className="w-4 h-4" />
          <span className="text-[11px] font-semibold text-text-secondary">Fibonacci</span>
        </div>
      )}
      <div className={isUser ? 'text-sm text-text-primary leading-relaxed' : 'pl-5'}>
        {/* Reasoning / thinking channel (Hermes <|channel>thought) */}
        {!isUser && message.reasoning && message.reasoning.trim().length > 0 && (
          <ReasoningBlock reasoning={message.reasoning} />
        )}
        {message.content ? (
          isUser ? (
            <div className="whitespace-pre-wrap text-text-primary">{message.content}</div>
          ) : (
            <Markdown content={message.content} />
          )
        ) : message.pending ? (
          <div className="flex gap-1 items-center text-text-tertiary pl-5">
            <span className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-soft" />
            <span
              className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-soft"
              style={{ animationDelay: '0.2s' }}
            />
            <span
              className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-soft"
              style={{ animationDelay: '0.4s' }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Collapsible reasoning / thinking block. Shows the model's reasoning channel
 * (extracted from the Hermes `<|channel>thought` token) in a collapsible
 * section above the main response content.
 */
const ReasoningBlock: React.FC<{ reasoning: string }> = ({ reasoning }) => {
  const [expanded, setExpanded] = React.useState(false);
  const preview = reasoning.slice(0, 80).replace(/\n/g, ' ');
  return (
    <div className="mb-2 border border-border-subtle rounded-card bg-input/40 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-tertiary hover:bg-input/80 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M5 3l6 5-6 5V3z" />
        </svg>
        <span className="font-medium">استدلال</span>
        {!expanded && (
          <span className="truncate text-text-tertiary/70" dir="ltr">
            {preview}
            {reasoning.length > 80 ? '…' : ''}
          </span>
        )}
      </button>
      {expanded && (
        <pre
          className="text-[11px] text-text-secondary whitespace-pre-wrap px-2 py-1.5 border-t border-border-subtle bg-input/60 max-h-64 overflow-y-auto"
          dir="ltr"
        >
          {reasoning}
        </pre>
      )}
    </div>
  );
};

/**
 * Compact activity line for tool calls — like Cline/Roo Code style.
 * Shows a single line: "[icon] reading index.html   ✓"
 * Click to expand the OUTPUT only (args/code are hidden for security & UX).
 */
const ToolBlock: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const t = useStore((s) => s.t);
  const expanded = useStore((s) => s.expandedToolIds[message.id]);
  const toggle = useStore((s) => s.toggleToolExpanded);
  const labelKey = TOOL_LABEL_KEYS[message.toolName ?? ''] ?? 'tool.executing';
  const category = inferCategory(message.toolName);
  const target = getToolTarget(message.toolName ?? '', message.toolArgs ?? {});

  return (
    <div className="animate-slide-up">
      <button
        onClick={() => toggle(message.id)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs bg-input/60 hover:bg-input border border-border-subtle rounded-card transition-colors duration-fast text-right"
      >
        <ToolIcon category={category} toolName={message.toolName} />
        <span className="text-text-secondary font-medium shrink-0">{t(labelKey)}</span>
        {target && (
          <code
            className="text-[11px] text-text-tertiary truncate flex-1 text-left"
            dir="ltr"
          >
            {target}
          </code>
        )}
        <span className="shrink-0 mr-auto">
          <StateBadge message={message} />
        </span>
        <svg
          className={`w-3 h-3 text-text-tertiary transition-transform shrink-0 ${
            expanded ? 'rotate-90' : ''
          }`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M5 3l6 5-6 5V3z" />
        </svg>
      </button>

      {/* Expanded body — OUTPUT ONLY, never show args/code */}
      {expanded && message.toolResult !== undefined && (
        <div className="mt-1 border border-border-subtle rounded-card bg-panel overflow-hidden">
          <div className="px-2 py-1.5">
            <div className="section-label mb-1">{t('tool.output')}</div>
            <pre
              className="text-[10px] text-text-secondary overflow-x-auto whitespace-pre-wrap bg-input rounded p-1.5 border border-border-subtle max-h-48 overflow-y-auto"
              dir="ltr"
            >
              {(message.toolResult || '(empty)').slice(0, 4000)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};

const StateBadge: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const t = useStore((s) => s.t);
  if (message.pending) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-status-warning font-medium">
        <span className="w-1.5 h-1.5 bg-status-warning rounded-full animate-pulse-soft" />
      </span>
    );
  }
  const icons: Record<string, { icon: string; color: string; title: string }> = {
    'auto-approved': { icon: '✓', color: 'text-status-info', title: t('tool.autoApproved') },
    approved: { icon: '✓', color: 'text-status-success', title: t('tool.approved') },
    rejected: { icon: '✕', color: 'text-status-error', title: t('tool.rejected') },
    error: { icon: '!', color: 'text-status-error', title: t('tool.error') },
  };
  const badge = icons[message.approvalState ?? ''];
  if (!badge) return null;
  return (
    <span className={`text-xs font-bold ${badge.color}`} title={badge.title}>
      {badge.icon}
    </span>
  );
};

const ToolIcon: React.FC<{ category: string; toolName?: string }> = ({ category, toolName }) => {
  const common = 'w-3.5 h-3.5 shrink-0';
  if (toolName === 'read_file' || toolName === 'list_files' || toolName === 'search_files'
      || toolName === 'grep_search' || toolName === 'glob_files' || toolName === 'document_symbols'
      || toolName === 'workspace_symbols' || toolName === 'diagnostics' || toolName === 'open_file') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#3794ff' }}>
        <path d="M2 2h6l4 4v8H2V2zm5 1H3v10h9V7H7V3z" />
        <path d="M8 3v3h3l-3-3z" opacity="0.5" />
      </svg>
    );
  }
  if (toolName === 'write_to_file' || toolName === 'replace_in_file'
      || toolName === 'insert_at_line' || toolName === 'delete_lines' || toolName === 'append_to_file'
      || toolName === 'format_code') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#4ec9b0' }}>
        <path d="M11.5 2L14 4.5 5 13.5l-3 .5.5-3L11.5 2zm-1 1L3 10.5l-.3 1.8 1.8-.3L12 4.5 10.5 3z" />
      </svg>
    );
  }
  if (category === 'terminal') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#cca700' }}>
        <path d="M2 3h12v10H2V3zm1 1v8h10V4H3zm1 1l2 2-2 2h1l2-2-2-2H4zm4 3h3v1H8V8z" />
      </svg>
    );
  }
  if (category === 'mcp') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#FE03C3' }}>
        <path d="M10 2v3H6V2H4v3h-.5A1.5 1.5 0 0 0 2 6.5v2A1.5 1.5 0 0 0 3.5 10H4v3h2v-3h4v3h2v-3h.5A1.5 1.5 0 0 1 14 8.5v-2A1.5 1.5 0 0 0 12.5 5H12V2h-2z" />
      </svg>
    );
  }
  if (category === 'web' || toolName === 'web_fetch' || toolName === 'web_search') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#569cd6' }}>
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1c1 0 2 2 2 5s-1 5-2 5-2-2-2-5 1-5 2-5zM2.5 6h2c-.1.7-.2 1.3-.2 2s.1 1.3.2 2h-2A5.5 5.5 0 012.5 6zm11 0c.3.6.5 1.3.5 2s-.2 1.4-.5 2h-2c.1-.7.2-1.3.2-2s-.1-1.3-.2-2h2z" />
      </svg>
    );
  }
  if (category === 'git' || toolName === 'git_status' || toolName === 'git_diff' || toolName === 'git_log') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#f14e32' }}>
        <path d="M15.7 7.3L8.7.3a1 1 0 00-1.4 0L5.8 1.8l2 2a1.2 1.2 0 011.6 1.6l2 2a1.2 1.2 0 11-.7.7l-1.8-1.8v4.7a1.2 1.2 0 11-1 0V6.5L5.1 8.6a1.2 1.2 0 11-.7-.7l2-2V1.2L4.3.3a1 1 0 00-1.4 0l-2.6 2.6a1 1 0 000 1.4l7 7a1 1 0 001.4 0l7-7a1 1 0 000-1.4z" />
      </svg>
    );
  }
  if (category === 'reasoning' || toolName === 'think') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#c586c0' }}>
        <path d="M8 1a4 4 0 00-3 6.7V9a1 1 0 001 1h4a1 1 0 001-1v-1.3A4 4 0 008 1zm-1 11a1 1 0 102 0 1 1 0 00-2 0zm0 2.5a1 1 0 102 0 1 1 0 00-2 0z" />
      </svg>
    );
  }
  if (category === 'skill' || toolName === 'list_skills' || toolName === 'view_skill' || toolName === 'invoke_skill') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#dcdcaa' }}>
        <path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5l2-5z" />
      </svg>
    );
  }
  if (toolName === 'delegate_task') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#9cdcfe' }}>
        <path d="M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z" />
      </svg>
    );
  }
  if (toolName === 'execute_code') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#ce9178' }}>
        <path d="M1 4l4 4-4 4h2l4-4-4-4H1zm6 0v8h8V4H7zm1 1h6v6H8V5z" />
      </svg>
    );
  }
  if (toolName === 'memory') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#b5cea8' }}>
        <path d="M2 3h12v10H2V3zm1 1v8h10V4H3zm2 1h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z" />
      </svg>
    );
  }
  if (category === 'editor' || toolName === 'code_actions') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#d16969' }}>
        <path d="M2 2l3 12 3-3 6 3-3-6 3-3-9-3-3 0z" />
      </svg>
    );
  }
  return (
    <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#858585' }}>
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
};

function inferCategory(toolName?: string): 'file' | 'terminal' | 'mcp' | 'web' | 'git' | 'editor' | 'reasoning' | 'skill' {
  if (!toolName) return 'file';
  if (
    toolName.startsWith('mcp_') ||
    ['list_mcp_tools', 'call_mcp_tool', 'get_mcp_resources', 'manage_mcp_servers'].includes(toolName)
  ) {
    return 'mcp';
  }
  if (['execute_command', 'run_in_terminal', 'get_command_output'].includes(toolName)) {
    return 'terminal';
  }
  if (['web_fetch', 'web_search'].includes(toolName)) {
    return 'web';
  }
  if (['git_status', 'git_diff', 'git_log'].includes(toolName)) {
    return 'git';
  }
  if (['diagnostics', 'format_code', 'document_symbols', 'workspace_symbols', 'code_actions', 'open_file'].includes(toolName)) {
    return 'editor';
  }
  if (['think'].includes(toolName)) {
    return 'reasoning';
  }
  if (['list_skills', 'view_skill', 'invoke_skill'].includes(toolName)) {
    return 'skill';
  }
  return 'file';
}
