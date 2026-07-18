import React from 'react';
import type { ApprovalRequest } from '@shared/index';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

/** Extract a human-readable target (file path / command) from tool args. */
function getApprovalTarget(toolName: string, args: Record<string, unknown>): string {
  if (!args) return '';
  switch (toolName) {
    case 'write_to_file':
    case 'replace_in_file':
    case 'read_file':
    case 'insert_at_line':
    case 'delete_lines':
    case 'append_to_file':
    case 'format_code':
    case 'document_symbols':
    case 'code_actions':
    case 'open_file':
      return String(args.path ?? '');
    case 'execute_command':
    case 'run_in_terminal':
      return String(args.command ?? '');
    case 'call_mcp_tool':
      return `${args.server ?? ''}/${args.tool ?? ''}`;
    case 'list_files':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
      return args.path ? String(args.path) : '(workspace root)';
    case 'search_files':
    case 'grep_search':
    case 'web_search':
    case 'workspace_symbols':
      return args.query || args.pattern ? `"${String(args.query ?? args.pattern ?? '')}"` : '';
    case 'glob_files':
      return args.pattern ? String(args.pattern) : '';
    case 'web_fetch':
      return args.url ? String(args.url) : '';
    case 'execute_code':
      return `${args.language ?? 'python3'} (${(args.script as string ?? '').length} chars)`;
    case 'delegate_task':
      return `${((args.tasks as unknown[]) ?? []).length} subagent(s)`;
    case 'memory':
      return `${((args.operations as unknown[]) ?? []).length} op(s)`;
    default:
      return '';
  }
}

/** File-writing tools that show a "review in editor" hint. */
const FILE_WRITING_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
]);

export const ApprovalDialog: React.FC<{ request: ApprovalRequest }> = ({ request }) => {
  const t = useStore((s) => s.t);
  const [reason, setReason] = React.useState('');
  const [showReason, setShowReason] = React.useState(false);

  const respond = (approved: boolean) => {
    postToHost({
      type: 'APPROVE',
      requestId: request.id,
      approved,
      reason: reason || undefined,
    });
  };

  const isFileWriting = FILE_WRITING_TOOLS.has(request.toolName);

  return (
    <div className="border border-status-warning/40 bg-status-warning/5 rounded-card animate-slide-up overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-status-warning/10">
        <svg className="w-4 h-4 text-status-warning shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1l7 13H1L8 1zm0 3L3.5 12h9L8 4zm-1 5h2v2H7V9zm0-3h2v2H7V6z" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold text-status-warning uppercase tracking-wide">
            {t('approval.title')}
          </div>
          <div className="text-xs text-text-primary truncate">{request.description}</div>
        </div>
      </div>

      {/* Target preview — file path / command */}
      <div className="px-3 py-2 border-t border-status-warning/20 bg-panel">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-text-tertiary shrink-0">هدف:</span>
          <code className="text-text-secondary truncate text-left" dir="ltr">
            {getApprovalTarget(request.toolName, request.args)}
          </code>
        </div>
      </div>

      {/* "Review in editor" hint for file-writing tools */}
      {isFileWriting && (
        <div className="px-3 py-2 border-t border-status-warning/20" style={{ backgroundColor: 'rgba(55, 148, 255, 0.12)' }}>
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: '#3794ff' }}>
            <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 2h6l4 4v8H2V2zm5 1H3v10h9V7H7V3z" />
              <path d="M5 6h4v1H5V6zm0 2h4v1H5V8z" opacity="0.6" />
            </svg>
            <span className="font-medium">کد در ویرایشگر نمایش داده شد — لطفاً بررسی کنید سپس تأیید کنید.</span>
          </div>
        </div>
      )}

      {/* Optional reason */}
      {showReason && (
        <div className="px-3 py-2 border-t border-status-warning/20">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('approval.reason')}
            className="w-full bg-input text-text-primary text-xs rounded-card px-2 py-1.5 outline-none border border-border-input focus:border-border-focus"
            dir="rtl"
            autoFocus
          />
        </div>
      )}

      {/* Action buttons */}
      <div className="px-3 py-2 border-t border-status-warning/20 bg-input/40 flex items-center justify-between gap-2">
        <button
          onClick={() => setShowReason((v) => !v)}
          className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors duration-fast"
        >
          {showReason ? t('common.close') : t('approval.reason')}
        </button>
        <div className="flex gap-1.5">
          <button
            onClick={() => respond(false)}
            className="bg-elevated-2 hover:bg-status-error/30 text-text-primary hover:text-status-error text-xs px-3 py-1.5 rounded-button border border-border-input hover:border-status-error/40 transition-colors duration-fast"
          >
            {t('approval.no')}
          </button>
          <button
            onClick={() => respond(true)}
            className="bg-status-success hover:opacity-90 text-white text-xs px-3 py-1.5 rounded-button font-medium transition-opacity duration-fast"
          >
            {t('approval.yes')}
          </button>
        </div>
      </div>
    </div>
  );
};
