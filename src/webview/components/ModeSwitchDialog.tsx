import React from 'react';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

export const ModeSwitchDialog: React.FC = () => {
  const t = useStore((s) => s.t);
  const request = useStore((s) => s.modeSwitchRequest);
  const setModeSwitchRequest = useStore((s) => s.setModeSwitchRequest);
  const setAgentMode = useStore((s) => s.setAgentMode);

  if (!request) return null;

  const targetModeLabel =
    request.mode === 'coding' ? t('mode.coding') : t('mode.plan');

  const respond = (approved: boolean) => {
    if (approved) {
      setAgentMode(request.mode);
    }
    setModeSwitchRequest(null);
    postToHost({ type: 'MODE_SWITCH_RESPONSE', approved });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in">
      <div className="bg-panel border border-border-input rounded-lg max-w-xs w-full mx-4 overflow-hidden animate-scale-in shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-status-info/8 border-b border-status-info/15">
          <svg className="w-4 h-4 text-status-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span className="text-xs font-semibold text-status-info">{t('mode.switch.title')}</span>
        </div>

        {/* Body */}
        <div className="px-3 py-2.5 space-y-1.5">
          <p className="text-xs text-text-primary">
            {t('mode.switch.body')}{' '}
            <span className="font-semibold text-brand">{targetModeLabel}</span>
          </p>
          {request.reason && (
            <div className="text-2xs text-text-muted bg-elevated rounded px-2 py-1.5 border border-border-subtle">
              {request.reason}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-3 py-2 border-t border-border-subtle flex items-center justify-end gap-1.5">
          <button
            onClick={() => respond(false)}
            className="bg-elevated hover:bg-hover text-text-secondary text-2xs px-2.5 py-1 rounded border border-border-subtle transition-colors"
          >
            {t('mode.switch.reject')}
          </button>
          <button
            onClick={() => respond(true)}
            className="bg-brand hover:bg-brand-hover text-white text-2xs px-2.5 py-1 rounded font-medium transition-colors"
          >
            {t('mode.switch.approve')}
          </button>
        </div>
      </div>
    </div>
  );
};
