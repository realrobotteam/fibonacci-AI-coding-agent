import React from 'react';
import type { ApprovalRequest } from '@shared/index';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

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
    case 'open_file':
      return String(args.path ?? '');
    case 'execute_command':
    case 'run_in_terminal':
      return String(args.command ?? '');
    case 'call_mcp_tool':
      return `${args.server ?? ''}/${args.tool ?? ''}`;
    default:
      return '';
  }
}

const FILE_TOOLS = new Set(['write_to_file', 'replace_in_file', 'insert_at_line', 'delete_lines', 'append_to_file']);

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

  const target = getApprovalTarget(request.toolName, request.args);
  const isFileWrite = FILE_TOOLS.has(request.toolName);

  return (
    <div className="border border-status-warning/30 bg-status-warning/5 rounded-md animate-slide-up overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-status-warning/8">
        <svg className="w-3.5 h-3.5 text-status-warning shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-2xs font-semibold text-status-warning">{t('approval.title')}</div>
          <div className="text-2xs text-text-secondary truncate">{request.description}</div>
        </div>
      </div>

      {/* Target */}
      {target && (
        <div className="px-2.5 py-1 border-t border-status-warning/15">
          <code className="text-2xs text-text-muted truncate" dir="ltr">{target}</code>
        </div>
      )}

      {/* File write hint */}
      {isFileWrite && (
        <div className="px-2.5 py-1 border-t border-status-warning/15 text-2xs text-status-info">
          {t('approval.fileHint')}
        </div>
      )}

      {/* Reason input */}
      {showReason && (
        <div className="px-2.5 py-1 border-t border-status-warning/15">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('approval.reason')}
            className="w-full bg-input text-text-primary text-2xs rounded px-2 py-1 outline-none border border-border-input focus:border-border-focus"
            dir="rtl"
            autoFocus
          />
        </div>
      )}

      {/* Actions */}
      <div className="px-2.5 py-1.5 border-t border-status-warning/15 flex items-center justify-between">
        <button
          onClick={() => setShowReason((v) => !v)}
          className="text-2xs text-text-muted hover:text-text-secondary"
        >
          {showReason ? t('common.close') : t('approval.reason')}
        </button>
        <div className="flex gap-1.5">
          <button
            onClick={() => respond(false)}
            className="bg-elevated hover:bg-hover text-text-secondary text-2xs px-2.5 py-1 rounded border border-border-subtle hover:border-status-error/30 hover:text-status-error transition-colors"
          >
            {t('approval.no')}
          </button>
          <button
            onClick={() => respond(true)}
            className="bg-status-success hover:opacity-90 text-white text-2xs px-2.5 py-1 rounded font-medium transition-opacity"
          >
            {t('approval.yes')}
          </button>
        </div>
      </div>
    </div>
  );
};
