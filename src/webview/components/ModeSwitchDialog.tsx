import React from 'react';
import { useStore } from '../store/useStore';
import { postMessage as postToHost } from '../vscodeApi';

/**
 * Mode-switch popup — shown when the AI requests to change between
 * Plan mode and Coding mode. The user must approve before the switch
 * happens automatically.
 */
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
      // Update local UI state immediately so the dropdown reflects the new mode.
      setAgentMode(request.mode);
    }
    setModeSwitchRequest(null);
    postToHost({ type: 'MODE_SWITCH_RESPONSE', approved });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-slide-up">
      <div className="bg-panel border border-border-input rounded-card max-w-sm w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-status-info/10 border-b border-status-info/20">
          <svg className="w-5 h-5 text-status-info shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm1 8H7V7h2v5z" />
          </svg>
          <div className="flex-1">
            <div className="text-sm font-semibold text-status-info">
              {t('mode.switch.title')}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2">
          <p className="text-sm text-text-primary">
            {t('mode.switch.body')}{' '}
            <span className="font-semibold text-brand">{targetModeLabel}</span>
          </p>
          {request.reason && (
            <div className="text-xs text-text-tertiary bg-input rounded-card px-3 py-2 border border-border-subtle">
              <div className="font-medium text-text-secondary mb-1">
                {t('mode.switch.reason')}:
              </div>
              {request.reason}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-border-subtle bg-input/40 flex items-center justify-end gap-2">
          <button
            onClick={() => respond(false)}
            className="bg-elevated-2 hover:bg-hover text-text-secondary hover:text-text-primary text-xs px-3 py-1.5 rounded-button border border-border-input transition-colors duration-fast"
          >
            {t('mode.switch.reject')}
          </button>
          <button
            onClick={() => respond(true)}
            className="bg-brand hover:bg-brand-hover text-white text-xs px-3 py-1.5 rounded-button font-medium transition-colors duration-fast"
          >
            {t('mode.switch.approve')}
          </button>
        </div>
      </div>
    </div>
  );
};
