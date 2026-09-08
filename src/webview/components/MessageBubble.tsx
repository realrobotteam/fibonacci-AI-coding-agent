import React from 'react';
import type { ChatMessage, CheckpointMeta, SubtaskInfo, TokenUsage } from '@shared/index';
import { stripModeTag } from '@shared/index';
import { useStore } from '../store/useStore';
import { Markdown } from './Markdown';
import { ErrorBoundary } from './ErrorBoundary';
import { postMessage as postToHost } from '../vscodeApi';
import { fill, formatCost, formatDuration, formatK } from '../lib/format';
import { HighlightedCode } from '../lib/highlight';

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
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // FIX: clear the pending timeout on unmount so we never setState after
  // the bubble is removed from the list.
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
  const copy = React.useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(null), 1500);
    } catch { /* clipboard unavailable */ }
  }, []);
  return { copiedId, copy };
}

/* ── Main MessageBubble ── */

export const MessageBubble: React.FC<{
  message: ChatMessage;
  isLastAssistant?: boolean;
}> = (props) => (
  <ErrorBoundary fallback={<div className="text-status-error text-xs p-1">[message failed to render]</div>}>
    <MessageBubbleInner {...props} />
  </ErrorBoundary>
);

const MessageBubbleInner: React.FC<{
  message: ChatMessage;
  isLastAssistant?: boolean;
}> = ({ message, isLastAssistant }) => {
  // Selector is a no-op for non-assistant messages (no re-render churn on tool rows).
  const checkpoint = useStore((s) =>
    message.role === 'assistant' ? s.checkpoints[message.id] : undefined
  );

  if (message.role === 'tool') {
    return <ToolBlock message={message} />;
  }

  const isUser = message.role === 'user';

  return (
    <div className={`group/msg animate-slide-up ${isUser ? 'user-msg' : 'assistant-msg'}`}>
      {/* Assistant branding (logo + name) removed per request */}

      {/* Content */}
      <div>
        {/* Reasoning */}
        {!isUser && message.reasoning && message.reasoning.trim().length > 0 && (
          <ReasoningBlock reasoning={message.reasoning} />
        )}

        {message.content ? (
          isUser ? (
            /* Kilo-style: compact bubble pushed to the logical end edge */
            <div className="flex justify-end">
              <UserContent content={message.content} messageId={message.id} />
            </div>
          ) : (
            <AssistantContent message={message} isLast={!!isLastAssistant} />
          )
        ) : message.pending ? (
          <TypingIndicator />
        ) : null}

        {/* Attached images (vision input) — below the text bubble */}
        {isUser && message.images && message.images.length > 0 && (
          <UserImages images={message.images} />
        )}
      </div>

      {/* Checkpoint chip (pre-edit snapshot restore, Cline-style) */}
      {!isUser && checkpoint && <CheckpointChip checkpoint={checkpoint} />}
    </div>
  );
};

/* ── User message ── */

const UserContent: React.FC<{ content: string; messageId: string }> = ({ content, messageId }) => {
  const t = useStore((s) => s.t);
  const startEdit = useStore((s) => s.startEdit);
  const { copiedId, copy } = useCopyFeedback();
  // Hide the internal "[PLAN MODE]"-style tag for display, and edit the
  // stripped text so it matches the host's EDIT_USER_MESSAGE handler.
  const displayText = stripModeTag(content);

  // Kilo-style user bubble: dark rounded surface, NO border, compact.
  return (
    <div className="max-w-[85%] rounded-2xl bg-elevated px-3.5 py-2.5">
      <div className="text-[13px] text-text-primary whitespace-pre-wrap leading-relaxed">{displayText}</div>
      <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
        <MsgBtn
          title={copiedId === messageId ? t('common.copied') : t('common.copy')}
          onClick={() => copy(messageId, displayText)}
        >
          {copiedId === messageId ? <IconCheck /> : <IconCopy />}
        </MsgBtn>
        <MsgBtn title={t('common.edit')} onClick={() => startEdit(displayText)}>
          <IconEdit />
        </MsgBtn>
      </div>
    </div>
  );
};

/* ── Attached images on a user message (vision input) ── */

const UserImages: React.FC<{ images: string[] }> = ({ images }) => {
  const t = useStore((s) => s.t);
  return (
    <div className="mt-1 flex flex-wrap justify-end gap-1.5">
      {images.map((src, i) => (
        <img
          key={`${i}:${src.length}`}
          src={src}
          alt={t('vision.attachedImage')}
          loading="lazy"
          className="max-h-28 rounded-md border border-border-subtle"
        />
      ))}
    </div>
  );
};

/* ── Assistant message ── */

/** Kilo-style per-message thumbs feedback — module-level so it survives
 *  re-renders/re-mounts without touching the store. */
const likedMessageIds = new Set<string>();
const dislikedMessageIds = new Set<string>();
type Feedback = 'up' | 'down' | null;

const AssistantContent: React.FC<{
  message: ChatMessage;
  isLast: boolean;
}> = ({ message, isLast }) => {
  const t = useStore((s) => s.t);
  const regenerate = useStore((s) => s.regenerateLastMessage);
  const isBusy = useStore((s) => s.isBusy);
  const setNotice = useStore((s) => s.setNotice);
  const { copiedId, copy } = useCopyFeedback();
  const [feedback, setFeedback] = React.useState<Feedback>(() =>
    likedMessageIds.has(message.id) ? 'up' : dislikedMessageIds.has(message.id) ? 'down' : null
  );

  // Clicking a thumb activates it, clicking the other side switches, clicking
  // the active one again clears.
  const applyFeedback = (kind: 'up' | 'down') => {
    const next: Feedback = feedback === kind ? null : kind;
    likedMessageIds.delete(message.id);
    dislikedMessageIds.delete(message.id);
    if (next === 'up') likedMessageIds.add(message.id);
    if (next === 'down') dislikedMessageIds.add(message.id);
    setFeedback(next);
    if (next !== null) setNotice(t('feedback.thanks'));
  };

  // Kilo speed chip: "102.6 t/s" — falls back to the ↑/↓ footnote below.
  const speed =
    typeof message.tokensPerSec === 'number' && message.tokensPerSec > 0
      ? message.tokensPerSec
      : null;

  return (
    <div>
      <Markdown content={message.content} />
      <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-fast">
        <MsgBtn
          title={copiedId === message.id ? t('common.copied') : t('common.copy')}
          onClick={() => copy(message.id, message.content)}
        >
          {copiedId === message.id ? <IconCheck /> : <IconCopy />}
        </MsgBtn>
        <MsgBtn
          title={t('feedback.up')}
          onClick={() => applyFeedback('up')}
          active={feedback === 'up'}
        >
          <IconThumbUp filled={feedback === 'up'} />
        </MsgBtn>
        <MsgBtn
          title={t('feedback.down')}
          onClick={() => applyFeedback('down')}
          active={feedback === 'down'}
        >
          <IconThumbDown filled={feedback === 'down'} />
        </MsgBtn>
        {isLast && !isBusy && (
          <MsgBtn title={t('chat.regenerate')} onClick={regenerate}>
            <IconRefresh />
          </MsgBtn>
        )}
        <MsgBtn
          title={t('message.fork')}
          ariaLabel={t('message.fork')}
          onClick={() => postToHost({ type: 'FORK_CHAT', messageId: message.id })}
        >
          <IconGitBranch />
        </MsgBtn>
        {speed !== null && (
          <span className="text-2xs text-text-muted ms-1" dir="ltr">
            {speed.toFixed(1)} t/s
          </span>
        )}
      </div>
      {/* Token/cost footnote — hidden when the speed chip replaces it */}
      {speed === null && message.usage && <UsageFootnote usage={message.usage} t={t} />}
    </div>
  );
};

/* ── Usage footnote (prompt/completion tokens + cost) ── */

const UsageFootnote: React.FC<{ usage: TokenUsage; t: (k: string) => string }> = ({ usage, t }) => (
  <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-text-tertiary font-mono" dir="ltr">
    <span title={t('usage.prompt')}>↑{formatK(usage.promptTokens)}</span>
    <span title={t('usage.completion')}>↓{formatK(usage.completionTokens)}</span>
    {usage.costUsd !== undefined && (
      <span title={t('usage.total')}>· {formatCost(usage.costUsd)}</span>
    )}
  </div>
);

/* ── Checkpoint chip (restore pre-edit snapshot) ── */

const CheckpointChip: React.FC<{ checkpoint: CheckpointMeta }> = ({ checkpoint }) => {
  const t = useStore((s) => s.t);

  const restore = () => {
    if (window.confirm(t('checkpoint.restoreConfirm'))) {
      postToHost({ type: 'RESTORE_CHECKPOINT', checkpointId: checkpoint.id });
    }
  };

  return (
    <div className="mt-1 inline-flex items-center gap-1 max-w-full bg-elevated-2 rounded px-1.5 py-0.5 text-2xs text-text-muted">
      <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span className="truncate min-w-0" title={checkpoint.label}>
        {fill(t('checkpoint.marker'), { label: checkpoint.label })}
      </span>
      <button
        onClick={restore}
        className="w-4 h-4 flex items-center justify-center rounded-sm shrink-0 hover:text-text-secondary hover:bg-hover transition-colors"
        title={t('checkpoint.restore')}
        aria-label={t('checkpoint.restore')}
      >
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
    </div>
  );
};

/* ── Message action button ── */

const MsgBtn: React.FC<{
  title: string;
  onClick: () => void;
  ariaLabel?: string;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, ariaLabel, active, children }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={ariaLabel ?? title}
    aria-pressed={active}
    className={`w-5 h-5 flex items-center justify-center rounded-sm transition-all duration-fast ${
      active ? 'text-brand' : 'text-text-muted hover:text-text-secondary'
    } hover:bg-hover`}
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

/* ── Reasoning block (Kilo style: brain + label, chevron at the far end) ── */

const ReasoningBlock: React.FC<{ reasoning: string }> = ({ reasoning }) => {
  const t = useStore((s) => s.t);
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between gap-1 px-0.5 py-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <span className="flex items-center gap-1 min-w-0">
          <IconBrain />
          <span className="text-xs text-text-secondary">{t('reasoning.title')}</span>
        </span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform duration-fast ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div
          className="mt-0.5 text-2xs italic text-text-secondary leading-relaxed bg-elevated/40 border border-border-subtle rounded-lg p-3 whitespace-pre-wrap max-h-48 overflow-y-auto"
          dir="ltr"
        >
          {reasoning}
        </div>
      )}
    </div>
  );
};

/* ── delegate_task subtask board (multi-agent visibility) ── */

/** Hard-cap a preview string (~80 chars for goals, 120 for answers/errors). */
const truncateText = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

const SubtaskStatusIcon: React.FC<{ status: SubtaskInfo['status']; t: (k: string) => string }> = ({ status, t }) => {
  const label = t(`subtask.${status}`);
  const cls = 'w-3 h-3 shrink-0';
  if (status === 'running') {
    return (
      <span className="shrink-0 inline-flex" title={label}>
        <svg
          className={`${cls} animate-spin text-status-info`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          role="img" aria-label={label}
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="shrink-0 inline-flex" title={label}>
        <svg
          className={`${cls} text-status-success`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          role="img" aria-label={label}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  return (
    <span className="shrink-0 inline-flex" title={label}>
      <svg
        className={`${cls} text-status-error`}
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        role="img" aria-label={label}
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </span>
  );
};

const SubtaskRow: React.FC<{ sub: SubtaskInfo; first: boolean; t: (k: string) => string }> = ({ sub, first, t }) => {
  const terminal = sub.status !== 'running';
  const metaParts: string[] = [];
  if (terminal && sub.iterations !== undefined) metaParts.push(fill(t('subtask.iterations'), { n: sub.iterations }));
  if (terminal && sub.durationMs !== undefined) metaParts.push(formatDuration(sub.durationMs));
  const metaTitle = terminal
    ? `${t('subtask.iterationsTitle')}: ${sub.iterations ?? '—'} · ${t('subtask.durationTitle')}: ${formatDuration(sub.durationMs)}`
    : undefined;

  return (
    <div className={`px-2 py-1.5 ${first ? '' : 'border-t border-border-subtle'}`} role="listitem">
      <div className="flex items-center gap-1.5 min-w-0">
        <SubtaskStatusIcon status={sub.status} t={t} />
        <span className="text-text-secondary truncate min-w-0 flex-1" title={sub.goal}>
          {truncateText(sub.goal, 80)}
        </span>
        <span
          className={`shrink-0 text-[9px] leading-none uppercase tracking-wide px-1 py-0.5 rounded border ${
            sub.role === 'orchestrator'
              ? 'text-brand border-brand/30 bg-brand/10'
              : 'text-text-tertiary border-border-subtle bg-elevated-2'
          }`}
        >
          {sub.role}
        </span>
        {metaParts.length > 0 && (
          <span className="shrink-0 font-mono text-text-muted" dir="ltr" title={metaTitle}>
            {metaParts.join(' · ')}
          </span>
        )}
      </div>
      {sub.status === 'done' && sub.answer && (
        <div className="mt-0.5 ps-4 flex items-center min-w-0">
          <span className="sr-only">{t('subtask.answer')}</span>
          <span className="text-2xs text-text-tertiary truncate min-w-0 flex-1" title={sub.answer}>
            {truncateText(sub.answer, 120)}
          </span>
        </div>
      )}
      {sub.status === 'failed' && sub.error && (
        <div className="mt-0.5 ps-4 flex items-center min-w-0">
          <span className="sr-only">{t('subtask.error')}</span>
          <span className="text-2xs text-status-error truncate min-w-0 flex-1" title={sub.error}>
            {truncateText(sub.error, 120)}
          </span>
        </div>
      )}
    </div>
  );
};

const SubtaskBoard: React.FC<{ subtasks: SubtaskInfo[] }> = ({ subtasks }) => {
  const t = useStore((s) => s.t);
  return (
    <div
      className="mt-0.5 bg-elevated-2/60 border border-border-subtle rounded-card overflow-hidden"
      role="list"
      aria-label={t('subtask.board')}
    >
      <div className="flex items-center gap-1 px-2 py-1 bg-elevated-2 border-b border-border-subtle text-2xs text-text-tertiary">
        <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span className="font-medium">{t('subtask.board')}</span>
        <span className="text-text-muted">{subtasks.length}</span>
      </div>
      {subtasks.map((sub, i) => (
        <SubtaskRow key={sub.id} sub={sub} first={i === 0} t={t} />
      ))}
    </div>
  );
};

/* ── Tool block (Kilo Code style) ────────────────────────────────────────
   Collapsed:  [icon] Write · index.html  +234 -0        [status] [>]
   Expanded:   a code card — file header (+/- stats, open-diff, copy) and a
   syntax-highlighted view with a green gutter bar (writes) or per-line
   red/green diff rows (replace_in_file SEARCH/REPLACE blocks). */

const FILE_WRITE_TOOLS = new Set(['write_to_file', 'replace_in_file', 'insert_at_line', 'delete_lines', 'append_to_file']);

/** Kilo-style one-word verbs per tool (i18n keys, wave-23). */
const TOOL_VERBS: Record<string, string> = {
  read_file: 'verb.read',
  write_to_file: 'verb.write',
  replace_in_file: 'verb.edit',
  insert_at_line: 'verb.insert',
  delete_lines: 'verb.delete',
  append_to_file: 'verb.append',
  format_code: 'verb.format',
  list_files: 'verb.list',
  glob_files: 'verb.glob',
  search_files: 'verb.search',
  grep_search: 'verb.grep',
  execute_command: 'verb.run',
  run_in_terminal: 'verb.run',
  get_command_output: 'verb.output',
  execute_code: 'verb.code',
  web_fetch: 'verb.fetch',
  web_search: 'verb.searchWeb',
  git_status: 'verb.git',
  git_diff: 'verb.git',
  git_log: 'verb.git',
  diagnostics: 'verb.diag',
  document_symbols: 'verb.symbols',
  workspace_symbols: 'verb.symbols',
  code_actions: 'verb.actions',
  open_file: 'verb.open',
  get_active_editor: 'verb.editor',
  list_mcp_tools: 'verb.mcp',
  call_mcp_tool: 'verb.mcp',
  get_mcp_resources: 'verb.mcp',
  manage_mcp_servers: 'verb.mcp',
  list_skills: 'verb.skill',
  view_skill: 'verb.skill',
  invoke_skill: 'verb.skill',
  think: 'verb.think',
  delegate_task: 'verb.delegate',
  memory: 'verb.memory',
};

function countContentLines(s: string): number {
  return s.length === 0 ? 0 : s.split('\n').length;
}

/** Parse `<<<<<<< SEARCH … ======= … >>>>>>> REPLACE` blocks into +/- counts. */
function parseSearchReplaceStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let section: 'search' | 'replace' | null = null;
  for (const raw of diff.split('\n')) {
    const t = raw.trim();
    if (/^<{5,9}\s*SEARCH\b/.test(t)) {
      section = 'search';
      continue;
    }
    if (/^={5,9}$/.test(t)) {
      section = 'replace';
      continue;
    }
    if (/^>{5,9}\s*REPLACE\b/.test(t)) {
      section = null;
      continue;
    }
    if (section === 'search') removed++;
    else if (section === 'replace') added++;
  }
  return { added, removed };
}

/** Webview-side fallback stats when host-side `diffStats` is absent (old chats). */
function fallbackDiffStats(message: ChatMessage): { added: number; removed: number } | null {
  const args = (message.toolArgs ?? {}) as Record<string, unknown>;
  switch (message.toolName) {
    case 'write_to_file':
    case 'insert_at_line':
    case 'append_to_file':
      return typeof args.content === 'string' ? { added: countContentLines(args.content), removed: 0 } : null;
    case 'replace_in_file': {
      const diff = typeof args.diff === 'string' ? args.diff : typeof args.content === 'string' ? args.content : '';
      return diff ? parseSearchReplaceStats(diff) : null;
    }
    case 'delete_lines': {
      const start = Math.max(1, Math.floor(Number(args.start_line ?? args.start ?? 1)));
      const end = Math.max(start, Math.floor(Number(args.end_line ?? args.end ?? start)));
      return { added: 0, removed: end - start + 1 };
    }
    default:
      return null;
  }
}

type DiffRow = { type: 'add' | 'del'; text: string };

/** SEARCH/REPLACE text → per-line add/del rows for the diff view. */
function parseSearchReplaceRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let section: 'search' | 'replace' | null = null;
  for (const raw of diff.split('\n')) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (/^<{5,9}\s*SEARCH\b/.test(t)) {
      section = 'search';
      continue;
    }
    if (/^={5,9}$/.test(t)) {
      section = 'replace';
      continue;
    }
    if (/^>{5,9}\s*REPLACE\b/.test(t)) {
      section = null;
      continue;
    }
    if (section === 'search') rows.push({ type: 'del', text: line });
    else if (section === 'replace') rows.push({ type: 'add', text: line });
  }
  return rows;
}

const extOf = (p: string): string => p.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '';

/** Kilo-style code card: file header row (+/- stats, open-diff, copy) + body. */
const CodeCard: React.FC<{
  path: string;
  added: number;
  removed: number;
  messageId: string;
  canOpenDiff: boolean;
  copyText: string;
  children: React.ReactNode;
}> = ({ path, added, removed, messageId, canOpenDiff, copyText, children }) => {
  const t = useStore((s) => s.t);
  const { copiedId, copy } = useCopyFeedback();
  const copyId = `${messageId}:code`;

  return (
    <div className="mt-0.5 mb-1 rounded-lg border border-border-subtle bg-panel overflow-hidden" dir="ltr">
      <div className="flex items-center gap-1.5 px-2 py-1 bg-elevated-2/60 border-b border-border-subtle text-2xs">
        <svg className="w-3 h-3 text-text-tertiary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span className="text-text-secondary truncate flex-1 min-w-0" title={path}>{path}</span>
        <span className="font-mono shrink-0" aria-label={`+${added} -${removed}`}>
          <span className="text-status-success">+{added}</span>{' '}
          <span className="text-status-error">-{removed}</span>
        </span>
        {canOpenDiff && (
          <button
            onClick={() => postToHost({ type: 'OPEN_TOOL_DIFF', messageId })}
            title={t('tool.openDiff')}
            aria-label={t('tool.openDiff')}
            className="w-4 h-4 flex items-center justify-center rounded-sm text-text-muted hover:text-brand hover:bg-hover transition-colors shrink-0"
          >
            <IconOpenDiff />
          </button>
        )}
        <button
          onClick={() => copy(copyId, copyText)}
          title={copiedId === copyId ? t('common.copied') : t('common.copy')}
          aria-label={copiedId === copyId ? t('common.copied') : t('common.copy')}
          className="w-4 h-4 flex items-center justify-center rounded-sm text-text-muted hover:text-brand hover:bg-hover transition-colors shrink-0"
        >
          {copiedId === copyId ? <IconCheck /> : <IconCopy />}
        </button>
      </div>
      <div className="max-h-64 overflow-auto">{children}</div>
    </div>
  );
};

/** Expanded body for file-write tool calls (Kilo code view). */
const WriteToolBody: React.FC<{ message: ChatMessage; added: number; removed: number }> = ({ message, added, removed }) => {
  const args = (message.toolArgs ?? {}) as Record<string, unknown>;
  const path = String(args.path ?? '');

  // replace_in_file → per-line red/green diff rows from the SEARCH/REPLACE text.
  if (message.toolName === 'replace_in_file') {
    const diffText = typeof args.diff === 'string' ? args.diff : typeof args.content === 'string' ? args.content : '';
    return (
      <CodeCard path={path || 'file'} added={added} removed={removed} messageId={message.id} canOpenDiff={!!message.diffStats} copyText={diffText}>
        <div className="font-mono text-2xs leading-relaxed py-0.5">
          {parseSearchReplaceRows(diffText).map((row, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-words ps-2 pe-2 py-px border-s-2 ${
                row.type === 'add'
                  ? 'bg-status-success/10 border-status-success text-text-primary'
                  : 'bg-status-error/10 border-status-error text-text-primary opacity-80'
              }`}
            >
              {row.text || '\u00A0'}
            </div>
          ))}
        </div>
      </CodeCard>
    );
  }

  // write/append/insert → Kilo all-additions view: green gutter bar + code.
  const content = typeof args.content === 'string' ? args.content : '';
  return (
    <CodeCard path={path || 'file'} added={added} removed={removed} messageId={message.id} canOpenDiff={!!message.diffStats} copyText={content}>
      <div className="flex">
        <div className="w-[3px] shrink-0 self-stretch rounded-full bg-status-success/70 my-1.5 ms-1.5" aria-hidden="true" />
        <pre className="flex-1 min-w-0 px-2 py-1.5 font-mono text-2xs leading-relaxed text-text-primary whitespace-pre-wrap break-words">
          <HighlightedCode code={content} lang={extOf(path)} />
        </pre>
      </div>
    </CodeCard>
  );
};

const ToolBlock: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const t = useStore((s) => s.t);
  const manual = useStore((s) => s.expandedToolIds[message.id]);
  const toggle = useStore((s) => s.toggleToolExpanded);
  const isWrite = FILE_WRITE_TOOLS.has(message.toolName ?? '');
  const verbKey = TOOL_VERBS[message.toolName ?? ''] ?? 'tool.executing';
  const category = inferCategory(message.toolName);
  const target = getToolTarget(message.toolName ?? '', message.toolArgs ?? {});
  const stats = message.diffStats ?? fallbackDiffStats(message);
  // Kilo behavior: write cards auto-expand while executing, then collapse —
  // unless the user toggled this card manually (manual override wins).
  const expanded = manual ?? (isWrite && message.pending === true);
  const showStats = !!stats && (stats.added > 0 || stats.removed > 0);

  return (
    <div className="animate-slide-up mr-2">
      {/* Compact Kilo activity row: icon + verb · target +N -M … chevron */}
      <button
        onClick={() => toggle(message.id)}
        aria-expanded={expanded}
        className="group/tool w-full flex items-center gap-1.5 py-1 px-1 rounded-sm bg-transparent text-2xs hover:bg-hover transition-colors duration-fast"
      >
        <ToolIcon category={category} toolName={message.toolName} />
        <span className="text-text-secondary font-medium shrink-0">{t(verbKey)}</span>
        {target ? (
          <>
            <span className="text-text-tertiary shrink-0" aria-hidden="true">·</span>
            <span className="text-text-muted truncate flex-1 min-w-0 text-left" dir="ltr" title={target}>{target}</span>
          </>
        ) : (
          <span className="flex-1 min-w-0" />
        )}
        {showStats && (
          <span className="shrink-0 font-mono text-2xs" dir="ltr">
            <span className="text-status-success">+{stats!.added}</span>{' '}
            <span className="text-status-error">-{stats!.removed}</span>
          </span>
        )}
        <ToolStatus message={message} />
        {/* Chevron — always visible (Kilo style), rotates when expanded */}
        <svg
          className={`w-3 h-3 shrink-0 text-text-muted transition-transform duration-fast ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {/* delegate_task live subtask board — always visible so multi-agent
          progress streams in without expanding (MESSAGE_UPDATE replaces the
          whole message via updateMessage, so rows update in place). */}
      {message.toolName === 'delegate_task' && Array.isArray(message.subtasks) && message.subtasks.length > 0 && (
        <SubtaskBoard subtasks={message.subtasks} />
      )}

      {/* Expanded body */}
      {expanded && isWrite && (
        <WriteToolBody message={message} added={stats?.added ?? 0} removed={stats?.removed ?? 0} />
      )}
      {expanded && !isWrite && message.toolResult !== undefined && (
        <div className="mt-0.5 rounded-md border border-border-subtle bg-panel overflow-hidden" dir="ltr">
          <pre
            className="text-2xs text-text-secondary overflow-x-auto whitespace-pre-wrap break-words p-1.5 font-mono max-h-44 overflow-y-auto"
          >
            {(message.toolResult || '(empty)').slice(0, 3000)}
          </pre>
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

const IconGitBranch = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

/* Thumbs (lucide geometry) — filled look via fill="currentColor" when active */

const IconThumbUp = ({ filled }: { filled?: boolean }) => (
  <svg
    className="w-3 h-3" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
  >
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);

const IconThumbDown = ({ filled }: { filled?: boolean }) => (
  <svg
    className="w-3 h-3" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
  >
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
  </svg>
);

/* Brain (simplified lucide brain: two hemispheres + inner curve) */

const IconBrain = () => (
  <svg className="w-3.5 h-3.5 shrink-0 text-text-tertiary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
    <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
  </svg>
);

/* Split-editor/diff icon for the code card's "open diff" action */

const IconOpenDiff = () => (
  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <path d="M7 9l2 3-2 3" />
    <path d="M17 9l-2 3 2 3" />
  </svg>
);
