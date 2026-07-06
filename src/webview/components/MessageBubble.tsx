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
      return String(args.path ?? '');
    case 'list_files':
      return args.path ? String(args.path) : '';
    case 'search_files':
      return args.query ? `"${args.query}"` : '';
    case 'get_active_editor':
      return '(current file)';
    case 'execute_command':
    case 'run_in_terminal':
      return String(args.command ?? '').split(' ').slice(0, 3).join(' ');
    case 'call_mcp_tool':
      return args.server ? `${args.server}/${args.tool ?? ''}` : '';
    case 'list_mcp_tools':
      return args.server ? String(args.server) : '';
    case 'get_mcp_resources':
      return args.server ? String(args.server) : '';
    case 'manage_mcp_servers':
      return args.action ? String(args.action) : '';
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
  if (toolName === 'read_file' || toolName === 'list_files' || toolName === 'search_files') {
    return (
      <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#3794ff' }}>
        <path d="M2 2h6l4 4v8H2V2zm5 1H3v10h9V7H7V3z" />
        <path d="M8 3v3h3l-3-3z" opacity="0.5" />
      </svg>
    );
  }
  if (toolName === 'write_to_file' || toolName === 'replace_in_file') {
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
  return (
    <svg className={common} viewBox="0 0 16 16" fill="currentColor" style={{ color: '#858585' }}>
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
};

function inferCategory(toolName?: string): 'file' | 'terminal' | 'mcp' {
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
  return 'file';
}
