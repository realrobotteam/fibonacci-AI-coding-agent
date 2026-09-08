import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import type { TodoItem } from '@shared/index';

export const TodoList: React.FC = () => {
  const stored = useStore((s) => s.todos);
  // FIX (e.filter crash): last-resort render guard — even if a non-array ever
  // reaches the store, the renderer must never crash the whole webview.
  const todos = Array.isArray(stored) ? stored : [];
  const t = useStore((s) => s.t);
  const [collapsed, setCollapsed] = useState(false);

  if (todos.length === 0) return null;

  // Cancelled items are excluded from the denominator entirely.
  const tracked = todos.filter((todo) => todo.status !== 'cancelled');
  const completed = tracked.filter((todo) => todo.status === 'completed').length;
  const total = tracked.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-b border-border-subtle bg-elevated/30 px-2.5 py-1.5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <svg className="w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span className="text-2xs font-medium text-text-secondary">{t('todo.title')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-text-muted font-mono" dir="ltr">
            {completed}/{total} · {progress}%
          </span>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-hover transition-colors"
            aria-expanded={!collapsed}
          >
            <svg className={`w-2.5 h-2.5 transition-transform ${collapsed ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </div>
      </div>

      {/* Thin progress bar — always visible (part of the header) */}
      <div className="h-1 bg-elevated rounded-full overflow-hidden mt-1">
        <div
          className="h-full bg-brand transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {!collapsed && (
        /* Items */
        <div className="space-y-0.5 mt-1">
          {todos.map((todo, i) => (
            <TodoRow key={i} todo={todo} />
          ))}
        </div>
      )}
    </div>
  );
};

const TodoRow: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  const isActive = todo.status === 'in_progress';
  const isDone = todo.status === 'completed';

  return (
    <div className={`flex items-start gap-1.5 px-1.5 py-0.5 rounded text-2xs ${isActive ? 'bg-brand/5' : ''}`}>
      <span className="shrink-0 mt-0.5">
        {isDone ? (
          <svg className="w-3 h-3 text-status-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : isActive ? (
          <span className="w-3 h-3 flex items-center justify-center">
            <span className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse-dot" />
          </span>
        ) : (
          <svg className="w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )}
      </span>
      <div className="flex-1 min-w-0">
        <span className={`${isDone ? 'text-text-muted line-through' : isActive ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
          {todo.content}
        </span>
        {isActive && todo.activeForm && (
          <div className="text-2xs text-brand mt-0.5 flex items-center gap-1">
            <span className="w-1 h-1 bg-brand rounded-full animate-pulse-dot" />
            {todo.activeForm}
          </div>
        )}
      </div>
    </div>
  );
};
