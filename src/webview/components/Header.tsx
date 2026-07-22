import React from 'react';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

export const Header: React.FC<{
  activeTab: 'chat' | 'settings';
  onNavigate: (tab: 'chat' | 'settings') => void;
  showHistoryButton?: boolean;
  onHistoryClick?: () => void;
}> = ({ activeTab, onNavigate, showHistoryButton = false, onHistoryClick }) => {
  const t = useStore((s) => s.t);
  const isBusy = useStore((s) => s.isBusy);
  const config = useStore((s) => s.config);
  const showToolCalls = useStore((s) => s.showToolCalls);
  const toggleShowToolCalls = useStore((s) => s.toggleShowToolCalls);

  const newChat = () => {
    onNavigate('chat');
    postToHost({ type: 'NEW_CHAT' });
  };

  return (
    <div className="flex items-center justify-between px-2.5 py-2 border-b border-border-subtle bg-panel">
      {/* Brand */}
      <button
        onClick={() => onNavigate('chat')}
        className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
      >
        <FibonacciLogo className="w-5 h-5 shrink-0" />
        <div className="flex flex-col min-w-0 text-right">
          <span className="text-xs font-semibold text-text-primary leading-tight">
            {t('app.title')}
          </span>
          {config && (
            <span className="text-2xs text-text-tertiary leading-tight">
              {config.apiKeySet ? (
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                  {t('app.online')}
                </span>
              ) : (
                <span className="text-status-warning">{t('app.offline')}</span>
              )}
            </span>
          )}
        </div>
      </button>

      {/* Actions */}
      <div className="flex items-center gap-0.5">
        {showHistoryButton && (
          <HeaderBtn title={t('history.title')} onClick={onHistoryClick || (() => {})}>
            <IconClock />
          </HeaderBtn>
        )}
        <HeaderBtn
          title={showToolCalls ? t('header.hideToolCalls') : t('header.showToolCalls')}
          onClick={toggleShowToolCalls}
          active={showToolCalls}
        >
          <IconTerminal />
        </HeaderBtn>
        <HeaderBtn title={t('chat.new')} onClick={newChat} disabled={isBusy}>
          <IconPlus />
        </HeaderBtn>
        <HeaderBtn
          title={t('settings.title')}
          onClick={() => onNavigate(activeTab === 'settings' ? 'chat' : 'settings')}
          active={activeTab === 'settings'}
        >
          <IconSettings />
        </HeaderBtn>
      </div>
    </div>
  );
};

const HeaderBtn: React.FC<{
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, active, children }) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`w-6 h-6 flex items-center justify-center rounded-sm transition-all duration-fast disabled:opacity-30 disabled:cursor-not-allowed ${
      active
        ? 'text-brand bg-brand/10'
        : 'text-text-tertiary hover:text-text-primary hover:bg-hover'
    }`}
  >
    {children}
  </button>
);

/* ── Icons (24x24 stroke, 1.5px weight) ── */

const IconClock = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const IconTerminal = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconPlus = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const IconSettings = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** Fibonacci spiral logo */
export const FibonacciLogo: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 128 128" fill="none">
    <path
      d="M 64 14 C 100 14 116 38 116 64 C 116 92 92 112 64 112 C 40 112 22 92 22 68 C 22 48 38 30 60 30 C 78 30 92 44 92 62 C 92 78 80 90 66 90 C 54 90 46 82 46 70 C 46 60 54 54 62 54 C 70 54 76 60 76 68 C 76 73 72 77 68 77 C 65 77 64 75 64 73 Z"
      fill="var(--vscode-terminal-ansiMagenta, #FE03C3)"
      fillRule="evenodd"
    />
  </svg>
);

// Keep old export name for backwards compatibility
export const FibonacciMascot = FibonacciLogo;
