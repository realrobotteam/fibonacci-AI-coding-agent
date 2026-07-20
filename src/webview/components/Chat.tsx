import React, { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { MessageBubble } from './MessageBubble';
import { ApprovalDialog } from './ApprovalDialog';
import { InputArea } from './InputArea';
import { TodoList } from './TodoList';
import { ModeSwitchDialog } from './ModeSwitchDialog';
import { ContextBar } from './ContextBar';
import { FibonacciLogo } from './Header';
import type { HistoryEntry } from '../store/useStore';

interface ChatProps {
  onLoadChat: (chatId: string) => void;
}

export const Chat: React.FC<ChatProps> = ({ onLoadChat }) => {
  const t = useStore((s) => s.t);
  const messages = useStore((s) => s.messages);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const todos = useStore((s) => s.todos);
  const showToolCalls = useStore((s) => s.showToolCalls);
  const endRef = useRef<HTMLDivElement>(null);

  const visibleMessages = showToolCalls
    ? messages
    : messages.filter((m) => m.role !== 'tool');

  // Find last assistant message index for regenerate button
  const lastAssistantIdx = (() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].role === 'assistant') return i;
    }
    return -1;
  })();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pendingApprovals.length, todos.length]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ContextBar />
      <div className="flex-1 overflow-y-auto">
        {visibleMessages.length === 0 && pendingApprovals.length === 0 && todos.length === 0 ? (
          <EmptyState onLoadChat={onLoadChat} />
        ) : (
          <>
            <TodoList />
            <div className="px-2.5 py-2 space-y-2.5">
              {visibleMessages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isLastAssistant={i === lastAssistantIdx}
                />
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

/* ── Empty state ── */

const EmptyState: React.FC<{ onLoadChat: (chatId: string) => void }> = ({ onLoadChat }) => {
  const t = useStore((s) => s.t);
  const history = useStore((s) => s.history);

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
      <FibonacciLogo className="w-10 h-10 mb-3 opacity-70" />
      <h2 className="text-sm font-semibold text-text-primary mb-1">
        {t('chat.empty.title')}
      </h2>
      <p className="text-2xs text-text-tertiary mb-5 max-w-[240px] leading-relaxed">
        {t('chat.empty.subtitle')}
      </p>

      {history.length > 0 && (
        <div className="w-full max-w-[260px]">
          <div className="section-label mb-1.5 text-right">{t('history.recent')}</div>
          <div className="space-y-1">
            {history.slice(0, 3).map((entry) => (
              <HistoryQuickCard key={entry.id} entry={entry} onLoadChat={onLoadChat} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const HistoryQuickCard: React.FC<{
  entry: HistoryEntry;
  onLoadChat: (chatId: string) => void;
}> = ({ entry, onLoadChat }) => {
  const t = useStore((s) => s.t);

  return (
    <button
      onClick={() => onLoadChat(entry.id)}
      className="w-full text-right bg-elevated/50 border border-border-subtle rounded-md px-2.5 py-1.5 hover:bg-hover hover:border-border-input transition-colors duration-fast"
    >
      <div className="text-2xs text-text-primary truncate font-medium">
        {entry.title || t('history.untitled')}
      </div>
      <div className="text-2xs text-text-muted mt-0.5 flex items-center gap-1.5 justify-end">
        <span>{formatTime(entry.ts)}</span>
        <span>·</span>
        <span>{entry.messageCount}</span>
      </div>
    </button>
  );
};

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString('fa-IR');
}
