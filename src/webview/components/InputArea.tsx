import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { ModelChoice } from '@shared';
import type { AgentMode } from '@shared/index';
import { postMessage as postToHost } from '../vscodeApi';

export const InputArea: React.FC = () => {
  const t = useStore((s) => s.t);
  const isBusy = useStore((s) => s.isBusy);
  const config = useStore((s) => s.config);
  const currentModel = useStore((s) => s.currentModel);
  const models = useStore((s) => s.models);
  const agentMode = useStore((s) => s.agentMode);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 160) + 'px';
    }
  }, [text]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    // Pass the current agent mode to the host as a prefix tag so the agent loop
    // can switch system prompts. We do this by wrapping the message.
    const modeTag = agentMode === 'plan' ? '[PLAN MODE] ' : '';
    postToHost({ type: 'SEND_MESSAGE', text: modeTag + trimmed });
    setText('');
  };

  const cancel = () => postToHost({ type: 'CANCEL' });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  const apiKeyMissing = config && !config.apiKeySet;
  const switchModel = (id: string) => postToHost({ type: 'SWITCH_MODEL', modelId: id });

  return (
    <div className="border-t border-border-subtle bg-panel px-3 py-2 space-y-2">
      {/* Warning if API key missing */}
      {apiKeyMissing && (
        <div className="text-[11px] text-status-error bg-status-error/10 border border-status-error/30 rounded-card px-2 py-1.5">
          {t('error.apiKeyMissing')}
        </div>
      )}

      {/* Composer card */}
      <div className="bg-input border border-border-input rounded-card focus-within:border-border-focus transition-colors duration-fast">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={isBusy ? t('chat.placeholder.busy') : t('chat.placeholder')}
          rows={1}
          className="block w-full bg-transparent text-text-primary text-base px-3 pt-2.5 pb-1 outline-none resize-none placeholder:text-text-tertiary disabled:opacity-50"
          dir="rtl"
          disabled={isBusy}
        />
        {/* Bottom row: ALL controls on a single row, using icon-only buttons
            for mode + model so they stay narrow even at 260px sidebar width.
            Layout (RTL): [mode-chip] [model-chip] ... [send-button] */}
        <div className="flex items-center justify-between gap-1.5 px-2 pb-2 pt-0.5">
          {/* Right side (RTL start) — mode + model chips, compact */}
          <div className="flex items-center gap-1 min-w-0 flex-1">
            <ModeChip
              mode={agentMode}
              onChange={setAgentMode}
              t={t}
            />
            <ModelChip
              models={models}
              current={currentModel}
              onChange={switchModel}
              t={t}
            />
          </div>
          {/* Left side (RTL end) — send/cancel button */}
          {isBusy ? (
            <button
              onClick={cancel}
              className="bg-status-error/90 hover:bg-status-error text-white text-xs px-3 py-1.5 rounded-button flex items-center gap-1 transition-colors duration-fast shrink-0"
              title={t('chat.cancel')}
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
              <span className="hidden sm:inline">{t('chat.cancel')}</span>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim()}
              className="bg-brand hover:bg-brand-hover text-white text-xs px-3 py-1.5 rounded-button flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-fast shrink-0"
              title={t('chat.send')}
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 8l12-5-5 12-2-5-5-2z" />
              </svg>
              <span className="hidden sm:inline">{t('chat.send')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Compact mode chip — icon + short label. Click to toggle between
 * coding and plan modes (no dropdown, since there are only 2 modes).
 */
const ModeChip: React.FC<{ 
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  t: (k: string) => string;
}> = ({ mode, onChange, t }) => {
  const isPlan = mode === 'plan';
  return (
    <button
      onClick={() => onChange(isPlan ? 'coding' : 'plan')}
      className={`flex items-center gap-1 px-1.5 py-1 rounded-pill text-[11px] border transition-colors duration-fast shrink-0 ${
        isPlan
          ? 'bg-status-info/20 border-status-info/40 text-status-info'
          : 'bg-brand/10 border-brand/30 text-brand'
      }`}
      title={isPlan ? t('mode.plan') : t('mode.coding')}
    >
      <svg className="w-3 h-3 shrink-0" viewBox="0 0 16 16" fill="currentColor">
        {isPlan ? (
          <path d="M2 3h12v10H2V3zm1 1v8h10V4H3zm2 2h6v1H5V6zm0 2h4v1H5V8z" />
        ) : (
          <path d="M5 2l8 6-8 6V2z" />
        )}
      </svg>
      <span className="truncate max-w-[60px]">{isPlan ? t('mode.plan') : t('mode.coding')}</span>
    </button>
  );
};

/**
 * Compact model selector — icon-only button that opens a dropdown. The
 * current model's full label is shown in the dropdown's selected item,
 * NOT on the chip itself. This keeps the chip narrow even at 260px sidebar.
 */
const ModelChip: React.FC<{ 
  models: ModelChoice[];
  current: string;
  onChange: (id: string) => void;
  t: (k: string) => string;
}> = ({ models, current, onChange, t }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const currentModel = models.find((m) => m.id === current);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-1 rounded-pill text-[11px] bg-elevated-2 border border-border-input text-text-secondary hover:text-text-primary hover:bg-hover transition-colors duration-fast"
        title={currentModel ? `${t('model.switch')}: ${currentModel.label}` : t('model.switch')}
      >
        <svg className="w-3 h-3 shrink-0 text-text-tertiary" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 3h12v10H2V3zm1 1v8h10V4H3z" />
          <path d="M5 6h6v1H5V6zm0 2h6v1H5V8z" />
        </svg>
        <svg className={`w-3 h-3 shrink-0 text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 16 16" fill="currentColor">
          <path d="M4 6l4 4 4-4H4z" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-1 right-0 min-w-[180px] max-w-[240px] bg-input border border-border-input rounded-card shadow-lg z-50 py-1 animate-slide-up"
          style={{ left: 'auto' }}
        >
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className={`w-full text-right px-3 py-1.5 text-[11px] hover:bg-hover transition-colors duration-fast ${
                m.id === current ? 'text-brand font-medium' : 'text-text-secondary'
              }`}
            >
              <div className="truncate">{m.label}</div>
              <div className="text-[10px] text-text-tertiary truncate flex items-center justify-between gap-2">
                <span>{m.description}</span>
                <span className="text-text-secondary font-mono">${m.outputCost.toFixed(2)}/1M</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};