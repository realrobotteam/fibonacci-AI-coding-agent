import React, { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';
import { formatCost } from '../lib/format';
import { stripModeTag } from '@shared/index';

/**
 * Kilo-style task strip: task title (first user message) on the start edge,
 * context % + token estimate + a details chevron on the end edge. The chevron
 * toggles a compact detail row beneath the strip (breakdown, cost, model,
 * message count, condense) — same data/math the old context bar exposed.
 */
export const ContextBar: React.FC = () => {
  const config = useStore((s) => s.config);
  const currentModel = useStore((s) => s.currentModel);
  const messages = useStore((s) => s.messages);
  const isBusy = useStore((s) => s.isBusy);
  const condensing = useStore((s) => s.condensing);
  const t = useStore((s) => s.t);
  const [open, setOpen] = useState(false);

  // FIX (perf): memoize the token estimate so it isn't recomputed over all
  // message content on every streamed-token re-render.
  const totalTokens = useMemo(
    () => messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0),
    [messages]
  );
  const contextLimit = config?.contextLimit || getContextLimit(currentModel);
  const usagePercent = contextLimit > 0 ? Math.min(100, (totalTokens / contextLimit) * 100) : 0;
  const totalCost = useMemo(
    () => messages.reduce((sum, m) => sum + (m.usage?.costUsd ?? 0), 0),
    [messages]
  );

  // Task title = first user message (truncated); fallback "New Task".
  const taskTitle = useMemo(() => {
    const firstUser = messages.find((m) => m.role === 'user');
    const raw = firstUser ? stripModeTag(firstUser.content).trim() : '';
    if (!raw) return t('task.new');
    const singleLine = raw.replace(/\s+/g, ' ');
    return singleLine.length > 42 ? `${singleLine.slice(0, 41).trimEnd()}…` : singleLine;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, t]);

  const systemTokens = config?.systemTokens;
  const toolsTokens = config?.toolsTokens;
  const hasBreakdown = systemTokens !== undefined || toolsTokens !== undefined;
  const conversationTokens = Math.max(
    0,
    totalTokens - ((systemTokens ?? 0) + (toolsTokens ?? 0))
  );

  const barColor =
    usagePercent >= 90 ? 'bg-status-error' :
    usagePercent >= 75 ? 'bg-status-warning' : 'bg-brand';

  const condense = () => {
    if (isBusy || condensing) return;
    useStore.getState().setCondensing(true);
    postToHost({ type: 'CONDENSE_CONTEXT' });
  };

  return (
    <div className="relative border-b border-border-subtle bg-elevated/30">
      {/* Thin context-usage line along the strip's bottom edge */}
      <div
        className="absolute bottom-0 start-0 h-[2px] transition-all duration-300"
        style={{ width: `${usagePercent}%` }}
        aria-hidden="true"
      >
        <div className={`h-full ${barColor}`} />
      </div>

      {/* Strip: title (start) · percent + tokens + details chevron (end) */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <span className="text-xs font-bold text-text-primary min-w-0 truncate" title={taskTitle}>
          {taskTitle}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className="text-2xs font-mono text-text-secondary"
            title={`${formatNumber(totalTokens)} / ${formatNumber(contextLimit)}`}
          >
            {Math.round(usagePercent)}%
          </span>
          {totalTokens > 0 && (
            <span className="text-2xs text-text-muted" title={t('context.title')}>
              {formatNumber(totalTokens)}
            </span>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t('context.details')}
            title={t('context.details')}
            className="relative w-5 h-5 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover transition-colors after:content-[''] after:absolute after:-inset-2"
          >
            <svg
              className={`w-3 h-3 transition-transform duration-fast ${open ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Compact detail row beneath the strip */}
      {open && (
        <div className="border-t border-border-subtle bg-elevated/20 px-2.5 py-1.5 space-y-0.5 animate-slide-up">
          <div className="flex items-center justify-between text-2xs text-text-muted">
            <span>{t('chat.model.label')}</span>
            <span className="font-mono truncate max-w-[60%]" dir="ltr">{currentModel}</span>
          </div>
          <div className="flex items-center justify-between text-2xs text-text-muted">
            <span>{t('history.messages')}</span>
            <span className="font-mono" dir="ltr">{messages.length}</span>
          </div>

          <div className="border-t border-border-subtle my-1" />

          <div className="flex items-center justify-between text-2xs text-text-muted">
            <span>{t('context.system')}</span>
            <span className="font-mono" dir="ltr">{systemTokens !== undefined ? formatNumber(systemTokens) : '—'}</span>
          </div>
          <div className="flex items-center justify-between text-2xs text-text-muted">
            <span>{t('context.tools')}</span>
            <span className="font-mono" dir="ltr">{toolsTokens !== undefined ? formatNumber(toolsTokens) : '—'}</span>
          </div>
          <div className="flex items-center justify-between text-2xs text-text-muted">
            <span>{t('context.conversation')}</span>
            <span className="font-mono" dir="ltr">{formatNumber(conversationTokens)}</span>
          </div>

          <div
            className="flex items-center justify-between text-2xs text-text-secondary"
            title={t('usage.total')}
          >
            <span>{t('usage.total')}</span>
            <span className="font-mono" dir="ltr">≈ {formatCost(totalCost)}</span>
          </div>

          {/* Condense */}
          <button
            onClick={condense}
            disabled={isBusy || condensing}
            className="mt-1 w-full flex items-center justify-center gap-1 text-2xs text-text-secondary rounded-button border border-border-subtle hover:bg-hover hover:text-text-primary px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {condensing ? (
              <>
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span>{t('context.condensing')}</span>
              </>
            ) : (
              <>
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <span>{t('context.condense')}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

function getContextLimit(model?: string): number {
  if (!model) return 128000;
  const limits: Record<string, number> = {
    'fibonacci-1-pro-max': 128000,
    'fibonacci-1-agentic': 128000,
    'fibonacci-2-coder': 128000,
    'fibonacci-2-sentiment': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 16384,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-3.5-sonnet': 200000,
  };
  for (const [key, limit] of Object.entries(limits)) {
    if (model.toLowerCase().includes(key.toLowerCase())) return limit;
  }
  return 128000;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}
