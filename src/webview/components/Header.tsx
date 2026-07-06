import React from 'react';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

/**
 * Compact header — logo + brand name on the right (RTL), icon actions on the left.
 */
export const Header: React.FC<{
  activeTab: 'chat' | 'settings';
  onNavigate: (tab: 'chat' | 'settings') => void;
}> = ({ activeTab, onNavigate }) => {
  const t = useStore((s) => s.t);
  const isBusy = useStore((s) => s.isBusy);
  const config = useStore((s) => s.config);

  const newChat = () => {
    onNavigate('chat');
    postToHost({ type: 'NEW_CHAT' });
  };

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle bg-panel">
      {/* Right side (RTL) — brand */}
      <button
        onClick={() => onNavigate('chat')}
        className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
        title={t('chat.new')}
      >
        <FibonacciMascot className="w-6 h-6 shrink-0" />
        <div className="flex flex-col min-w-0 text-right">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-text-primary leading-tight">
              {t('app.title')}
            </span>
            <span className="text-[10px] text-text-tertiary leading-tight">v1.0.3</span>
          </div>
          {config && (
            <span className="text-[10px] text-text-tertiary leading-tight truncate">
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

      {/* Left side (RTL) — actions */}
      <div className="flex items-center gap-0.5">
        <IconButton
          title={t('chat.new')}
          onClick={newChat}
          disabled={isBusy}
          active={activeTab === 'chat'}
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z" />
          </svg>
        </IconButton>
        <IconButton
          title={t('settings.title')}
          onClick={() => onNavigate(activeTab === 'settings' ? 'chat' : 'settings')}
          active={activeTab === 'settings'}
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.4h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.4-.5V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.8-.3zM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" />
          </svg>
        </IconButton>
      </div>
    </div>
  );
};

export const IconButton: React.FC<{
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
    className={`w-7 h-7 flex items-center justify-center rounded-button transition-colors duration-fast disabled:opacity-40 disabled:cursor-not-allowed ${
      active
        ? 'text-brand bg-brand/10'
        : 'text-text-tertiary hover:text-text-primary hover:bg-hover'
    }`}
  >
    {children}
  </button>
);

/** Fibonacci spiral logo — magenta open nautilus spiral, matching the official logo. */
export const FibonacciMascot: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M 64 14 C 100 14 116 38 116 64 C 116 92 92 112 64 112 C 40 112 22 92 22 68 C 22 48 38 30 60 30 C 78 30 92 44 92 62 C 92 78 80 90 66 90 C 54 90 46 82 46 70 C 46 60 54 54 62 54 C 70 54 76 60 76 68 C 76 73 72 77 68 77 C 65 77 64 75 64 73 Z"
      fill="#FE03C3"
      fillRule="evenodd"
    />
  </svg>
);
