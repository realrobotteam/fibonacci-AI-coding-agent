import React, { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { MessageBubble } from './MessageBubble';
import { ApprovalDialog } from './ApprovalDialog';
import { InputArea } from './InputArea';
import { TodoList } from './TodoList';
import { ModeSwitchDialog } from './ModeSwitchDialog';
import { FibonacciMascot } from './Header';
import { postMessage as postToHost } from '../vscodeApi';
import type { HistoryEntry } from '../store/useStore';

export const Chat: React.FC = () => {
  const t = useStore((s) => s.t);
  const messages = useStore((s) => s.messages);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const todos = useStore((s) => s.todos);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pendingApprovals.length, todos.length]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 && pendingApprovals.length === 0 && todos.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <TodoList />
            <div className="px-3 py-3 space-y-3">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {pendingApprovals.map((req) => (
                <ApprovalDialog key={req.id} request={req} />
              ))}
            </div>
          </>
        )}
        <div ref={endRef} />
      </div>
      <InputArea />
      <ModeSwitchDialog />
    </div>
  );
};

const EmptyState: React.FC = () => {
  const t = useStore((s) => s.t);
  const history = useStore((s) => s.history);

  return (
    <div className="h-full flex flex-col items-center justify-start text-center px-4 py-6 overflow-y-auto">
      <FibonacciMascot className="w-14 h-14 mb-3 opacity-90" />
      <h2 className="text-headline font-semibold text-text-primary mb-1">
        {t('chat.empty.title')}
      </h2>
      <p className="text-xs text-text-tertiary mb-6 max-w-[260px] leading-relaxed">
        {t('chat.empty.subtitle')}
      </p>

      {/* Chat history section — replaces the examples section */}
      <div className="w-full max-w-[300px]">
        <div className="section-label mb-2 text-right">{t('history.title')}</div>
        {history.length === 0 ? (
          <div className="text-xs text-text-muted bg-input rounded-card p-3 border border-border-subtle text-center">
            {t('history.empty')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {history.slice(0, 10).map((entry) => (
              <HistoryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const HistoryCard: React.FC<{ entry: HistoryEntry }> = ({ entry }) => {
  const t = useStore((s) => s.t);
  const [hovered, setHovered] = React.useState(false);

  const load = () => postToHost({ type: 'LOAD_CHAT', chatId: entry.id });
  const del = (e: React.MouseEvent) => {
    e.stopPropagation();
    postToHost({ type: 'DELETE_CHAT', chatId: entry.id });
  };

  return (
    <div
      onClick={load}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group bg-input border border-border-subtle rounded-card px-3 py-2 hover:bg-hover hover:border-border-input transition-colors duration-fast cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 text-right">
          <div className="text-xs text-text-primary truncate font-medium">
            {entry.title || t('history.untitled')}
          </div>
          <div className="text-[10px] text-text-tertiary mt-0.5 flex items-center gap-2 justify-end">
            <span>{formatTime(entry.ts, t)}</span>
            <span>·</span>
            <span>
              {entry.messageCount} {t('history.messages')}
            </span>
          </div>
        </div>
        {hovered && (
          <button
            onClick={del}
            title={t('history.delete')}
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-status-error hover:bg-status-error/10 transition-colors duration-fast"
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 2h4v1h4v2H2V3h4V2zm-3 4h10l-1 8H4L3 6zm2 1v6h1V7H5zm3 0v6h1V7H8zm3 0v6h1V7h-1z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
};

function formatTime(ts: number, _t: (k: string) => string): string {
  const now = Date.now();
  const diff = now - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'همین حالا';
  if (mins < 60) return `${mins} دقیقه پیش`;
  if (hours < 24) return `${hours} ساعت پیش`;
  if (days < 7) return `${days} روز پیش`;
  // Fall back to date
  const d = new Date(ts);
  return d.toLocaleDateString('fa-IR');
}
