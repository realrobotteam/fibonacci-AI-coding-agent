import React from 'react';
import { useStore } from '../store/useStore';

export const ContextBar: React.FC = () => {
  const t = useStore((s) => s.t);
  const config = useStore((s) => s.config);
  const currentModel = useStore((s) => s.currentModel);
  const messages = useStore((s) => s.messages);

  const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const contextLimit = config?.contextLimit || getContextLimit(currentModel);
  const usagePercent = contextLimit > 0 ? Math.min(100, (totalTokens / contextLimit) * 100) : 0;

  if (totalTokens === 0) return null;

  const barColor =
    usagePercent >= 90 ? 'bg-status-error' :
    usagePercent >= 75 ? 'bg-status-warning' : 'bg-brand';

  const textColor =
    usagePercent >= 90 ? 'text-status-error' :
    usagePercent >= 75 ? 'text-status-warning' : 'text-brand';

  return (
    <div className="border-b border-border-subtle bg-elevated/30 px-2.5 py-1">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-2xs text-text-muted">
          {formatNumber(totalTokens)} / {formatNumber(contextLimit)}
        </span>
        <span className={`text-2xs font-mono font-medium ${textColor}`}>
          {Math.round(usagePercent)}%
        </span>
      </div>
      <div className="h-1 bg-elevated rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${barColor}`}
          style={{ width: `${usagePercent}%` }}
        />
      </div>
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
