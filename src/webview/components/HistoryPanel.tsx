import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import type { HistoryEntry } from '../store/useStore';

export const HistoryPanel: React.FC<{
  onClose: () => void;
  onLoadChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
  onRenameChat: (chatId: string, newTitle: string) => void;
}> = ({ onClose, onLoadChat, onDeleteChat, onRenameChat }) => {
  const t = useStore((s) => s.t);
  const history = useStore((s) => s.history);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const filtered = history.filter((e) =>
    e.title.toLowerCase().includes(search.toLowerCase())
  );

  const startRename = (entry: HistoryEntry) => {
    setEditingId(entry.id);
    setEditTitle(entry.title);
  };

  const saveRename = (entry: HistoryEntry) => {
    if (editTitle.trim() && editTitle.trim() !== entry.title) {
      onRenameChat(entry.id, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 animate-fade-in">
      <div className="absolute inset-0 right-0 h-full w-full max-w-xs bg-panel border-l border-border-subtle flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
          <h2 className="text-xs font-semibold text-text-primary">{t('history.title')}</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-2.5 py-1.5 border-b border-border-subtle">
          <div className="relative">
            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('history.search')}
              className="w-full bg-input border border-border-input rounded px-2 py-1 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus pe-7"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-4 text-center">
              <svg className="w-8 h-8 text-text-muted mb-2 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <p className="text-xs text-text-muted">{search ? t('history.noResults') : t('history.empty')}</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {filtered.map((entry) => (
                <HistoryItem
                  key={entry.id}
                  entry={entry}
                  isEditing={editingId === entry.id}
                  editTitle={editTitle}
                  onEditTitleChange={setEditTitle}
                  onLoad={onLoadChat}
                  onDelete={onDeleteChat}
                  onStartRename={startRename}
                  onSaveRename={saveRename}
                  onCancelRename={() => setEditingId(null)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const HistoryItem: React.FC<{
  entry: HistoryEntry;
  isEditing: boolean;
  editTitle: string;
  onEditTitleChange: (title: string) => void;
  onLoad: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  onStartRename: (entry: HistoryEntry) => void;
  onSaveRename: (entry: HistoryEntry) => void;
  onCancelRename: () => void;
  t: (k: string) => string;
}> = ({ entry, isEditing, editTitle, onEditTitleChange, onLoad, onDelete, onStartRename, onSaveRename, onCancelRename, t }) => {
  const [hovered, setHovered] = useState(false);

  if (isEditing) {
    return (
      <div className="bg-input border border-border-input rounded px-2 py-1 animate-slide-up">
        <input
          type="text"
          value={editTitle}
          onChange={(e) => onEditTitleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSaveRename(entry);
            if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={() => onSaveRename(entry)}
          autoFocus
          className="w-full bg-transparent text-text-primary text-xs outline-none"
          dir="rtl"
        />
      </div>
    );
  }

  return (
    <div
      onClick={() => onLoad(entry.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="bg-elevated/50 border border-border-subtle rounded px-2.5 py-1.5 hover:bg-hover hover:border-border-input transition-colors duration-fast cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 text-right">
          <div className="text-xs text-text-primary truncate font-medium">
            {entry.title || t('history.untitled')}
          </div>
          <div className="text-2xs text-text-muted mt-0.5 flex items-center gap-1.5 justify-end">
            <span>{formatTime(entry.ts)}</span>
            <span>·</span>
            <span>{entry.messageCount}</span>
          </div>
        </div>
        {hovered && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onStartRename(entry); }}
              className="w-5 h-5 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t('history.deleteConfirm'))) onDelete(entry.id);
              }}
              className="w-5 h-5 flex items-center justify-center rounded-sm text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
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
