import React from 'react';
import { useStore } from '../store/useStore';
import type { TodoItem } from '@shared/index';

/**
 * Todo list panel — shows the AI's task checklist above the chat messages.
 * The AI calls `update_todos` to create/update this list. Each item has
 * a status: pending (○), in_progress (spinner), or completed (✓).
 */
export const TodoList: React.FC = () => {
  const todos = useStore((s) => s.todos);
  const t = useStore((s) => s.t);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border-b border-border-subtle bg-input/30 px-3 py-2 animate-slide-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-brand" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 3h12v10H2V3zm1 1v8h10V4H3zm2 1h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z" />
          </svg>
          <span className="section-label">{t('todo.title')}</span>
        </div>
        <span className="text-[10px] text-text-tertiary font-medium">
          {completed}/{total}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-elevated-2 rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-brand transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Items */}
      <div className="space-y-1">
        {todos.map((todo, i) => (
          <TodoRow key={i} todo={todo} index={i} />
        ))}
      </div>
    </div>
  );
};

const TodoRow: React.FC<{ todo: TodoItem; index: number }> = ({ todo }) => {
  const isActive = todo.status === 'in_progress';
  const isDone = todo.status === 'completed';

  return (
    <div
      className={`flex items-start gap-2 px-2 py-1 rounded text-xs transition-colors duration-fast ${
        isActive ? 'bg-brand/5 border border-brand/20' : 'border border-transparent'
      }`}
    >
      {/* Status icon */}
      <span className="shrink-0 mt-0.5">
        {isDone ? (
          <svg className="w-3.5 h-3.5 text-status-success" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-1 10L3.5 7.5l1-1L7 9l4.5-4.5 1 1L7 11z" />
          </svg>
        ) : isActive ? (
          <span className="inline-flex items-center justify-center w-3.5 h-3.5">
            <span className="w-2 h-2 bg-brand rounded-full animate-pulse-soft" />
          </span>
        ) : (
          <svg className="w-3.5 h-3.5 text-text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6" />
          </svg>
        )}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div
          className={`${
            isDone ? 'text-text-muted line-through' : 'text-text-secondary'
          } ${isActive ? 'text-text-primary font-medium' : ''}`}
        >
          {todo.content}
        </div>
        {isActive && todo.activeForm && (
          <div className="text-[10px] text-brand mt-0.5 flex items-center gap-1">
            <span className="w-1 h-1 bg-brand rounded-full animate-pulse-soft" />
            {todo.activeForm}
          </div>
        )}
      </div>
    </div>
  );
};
