import React, { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { MessageBubble } from './MessageBubble';
import { ApprovalDialog } from './ApprovalDialog';
import { InputArea } from './InputArea';
import { TodoList } from './TodoList';
import { ModeSwitchDialog } from './ModeSwitchDialog';
import { ContextBar } from './ContextBar';
import { FibonacciLogo } from './Header';

interface ChatProps {
  onLoadChat: (chatId: string) => void;
}

export const Chat: React.FC<ChatProps> = () => {
  const t = useStore((s) => s.t);
  const messages = useStore((s) => s.messages);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const todos = useStore((s) => s.todos);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // FIX (scroll fighting): track whether the user is near the bottom and only
  // auto-scroll then — previously every streamed token force-scrolled down,
  // even while the user was reading an earlier message.
  const stickToBottomRef = useRef(true);

  // Tool calls are ALWAYS visible now — render `messages` directly.

  // Find last assistant message index for regenerate button
  const lastAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i;
    }
    return -1;
  })();

  useEffect(() => {
    if (stickToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, pendingApprovals.length, todos.length, messages[messages.length - 1]?.content]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ContextBar />
      <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 && pendingApprovals.length === 0 && todos.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <TodoList />
            <div className="px-2.5 py-2 space-y-2.5">
              {messages.map((m, i) => (
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

/* ── Home page (restored): Fibonacci logo + greeting + example chips ── */

const EmptyState: React.FC = () => {
  const t = useStore((s) => s.t);
  const setComposerDraft = useStore((s) => s.setComposerDraft);

  const examples = ['chat.empty.example1', 'chat.empty.example2', 'chat.empty.example3'];

  return (
    <div className="min-h-full flex flex-col items-center justify-center px-4 pb-10 text-center">
      {/* Fibonacci golden-spiral logo (same gradient as the activity bar icon) */}
      <FibonacciLogo className="w-16 h-16 mb-4 animate-slide-up drop-shadow-[0_0_12px_rgba(254,3,195,0.25)]" />
      <h2 className="text-sm font-semibold text-text-primary animate-slide-up">{t('chat.empty.title')}</h2>
      <p className="text-2xs text-text-muted mt-1 max-w-[260px] leading-relaxed animate-slide-up">
        {t('chat.empty.subtitle')}
      </p>
      {/* Quick-start chips → prefill the composer */}
      <div className="mt-4 flex flex-col gap-1.5 w-full max-w-[280px]" role="list" aria-label={t('chat.empty.hint')}>
        {examples.map((key) => (
          <button
            key={key}
            role="listitem"
            onClick={() => setComposerDraft(t(key))}
            className="text-start text-2xs px-3 py-2 rounded-lg border border-border-subtle bg-elevated/50 text-text-secondary hover:bg-hover hover:text-text-primary hover:border-brand/40 transition-colors duration-fast truncate"
          >
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
};
