import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { ModelChoice } from '@shared';
import type { AgentMode, AutoApproveMode } from '@shared/index';
import { postMessage as postToHost } from '../vscodeApi';

export const InputArea: React.FC = () => {
  const t = useStore((s) => s.t);
  const isBusy = useStore((s) => s.isBusy);
  const config = useStore((s) => s.config);
  const currentModel = useStore((s) => s.currentModel);
  const models = useStore((s) => s.models);
  const agentMode = useStore((s) => s.agentMode);
  const setAgentMode = useStore((s) => s.setAgentMode);
  const autoApproveMode = config?.autoApproveMode ?? 'none';
  const editingText = useStore((s) => s.editingText);
  const cancelEdit = useStore((s) => s.cancelEdit);
  const messages = useStore((s) => s.messages);
  const [text, setText] = useState('');
  const [showImproved, setShowImproved] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingText !== null) {
      setText(editingText);
      ref.current?.focus();
    }
  }, [editingText]);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 120) + 'px';
    }
  }, [text]);

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { original, improved } = e.detail;
      if (improved !== original) setShowImproved(improved);
    };
    window.addEventListener('IMPROVED_PROMPT', handler as EventListener);
    return () => window.removeEventListener('IMPROVED_PROMPT', handler as EventListener);
  }, []);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;

    if (editingText !== null) {
      const store = useStore.getState();
      const msgs = store.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && msgs[i].content === editingText) {
          useStore.setState({ messages: msgs.slice(0, i) });
          break;
        }
      }
    }

    const modeTag = agentMode !== 'coding' ? `[${agentMode.toUpperCase()} MODE] ` : '';
    postToHost({ type: 'SEND_MESSAGE', text: modeTag + trimmed });
    setText('');
    setShowImproved(null);
    cancelEdit();
  };

  const cancel = () => postToHost({ type: 'CANCEL' });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const improvePrompt = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    postToHost({ type: 'IMPROVE_PROMPT', text: trimmed });
  };

  const acceptImproved = () => {
    if (showImproved) {
      setText(showImproved);
      setShowImproved(null);
    }
  };

  const apiKeyMissing = config && !config.apiKeySet;

  return (
    <div className="border-t border-border-subtle bg-panel p-2 space-y-1.5">
      {/* Edit mode banner */}
      {editingText !== null && (
        <div className="flex items-center justify-between text-2xs text-brand bg-brand/8 border border-brand/20 rounded-md px-2 py-1 animate-slide-up">
          <span className="font-medium">{t('chat.editingMode')}</span>
          <button onClick={cancelEdit} className="text-text-muted hover:text-text-primary">
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* API key warning */}
      {apiKeyMissing && (
        <div className="text-2xs text-status-error bg-status-error/8 border border-status-error/20 rounded-md px-2 py-1">
          {t('error.apiKeyMissing')}
        </div>
      )}

      {/* Composer */}
      <div className="bg-input border border-border-input rounded-lg focus-within:border-border-focus transition-colors">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={isBusy ? t('chat.placeholder.busy') : t('chat.placeholder')}
          rows={1}
          className="block w-full bg-transparent text-text-primary text-[13px] px-2.5 pt-2 pb-1 outline-none resize-none placeholder:text-text-muted disabled:opacity-50"
          dir="rtl"
          disabled={isBusy}
        />

        {/* Improved prompt preview */}
        {showImproved && (
          <div className="border-t border-border-subtle p-2 bg-brand/5 animate-slide-up">
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs font-medium text-brand">{t('chat.improvedPrompt')}</span>
              <div className="flex items-center gap-1.5">
                <button onClick={acceptImproved} className="text-2xs text-brand hover:underline">{t('chat.accept')}</button>
                <button onClick={() => setShowImproved(null)} className="text-2xs text-text-muted hover:text-text-primary">{t('chat.discard')}</button>
              </div>
            </div>
            <div className="text-xs text-text-secondary max-h-20 overflow-y-auto whitespace-pre-wrap">{showImproved}</div>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between gap-1 px-2 pb-1.5 pt-0.5">
          {/* Left: mode + model */}
          <div className="flex items-center gap-1 min-w-0 flex-1">
            <ModeSelector mode={agentMode} onChange={setAgentMode} t={t} />
            <ModelSelector models={models} current={currentModel} onChange={(id) => postToHost({ type: 'SWITCH_MODEL', modelId: id })} t={t} />
          </div>

          {/* Center: auto-approve + improve */}
          <div className="flex items-center gap-1 shrink-0">
            <AutoApproveSelector mode={autoApproveMode} onChange={(m) => postToHost({ type: 'SET_AUTO_APPROVE_MODE', mode: m })} t={t} />
            <button
              onClick={improvePrompt}
              disabled={!text.trim() || isBusy}
              className="w-6 h-6 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover disabled:opacity-30"
              title={t('chat.improvePrompt')}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L9.5 8.5 3 12l6.5 3.5L12 22l2.5-6.5L22 12l-6.5-3.5z" />
              </svg>
            </button>
          </div>

          {/* Right: send/cancel */}
          {isBusy ? (
            <button
              onClick={cancel}
              className="bg-status-error hover:opacity-90 text-white text-xs px-2.5 py-1 rounded-md flex items-center gap-1 shrink-0"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
              <span className="hidden sm:inline">{t('chat.cancel')}</span>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!text.trim()}
              className="bg-brand hover:bg-brand-hover text-white text-xs px-2.5 py-1 rounded-md flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              <span className="hidden sm:inline">{t('chat.send')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── Mode selector ── */

const ModeSelector: React.FC<{
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  t: (k: string) => string;
}> = ({ mode, onChange, t }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const modes: { value: AgentMode; label: string; color: string }[] = [
    { value: 'coding', label: t('mode.coding'), color: 'text-brand' },
    { value: 'plan', label: t('mode.plan'), color: 'text-status-info' },
    { value: 'ask', label: t('mode.ask'), color: 'text-status-success' },
    { value: 'debug', label: t('mode.debug'), color: 'text-status-warning' },
    { value: 'auto', label: t('mode.auto'), color: 'text-status-info' },
  ];

  const current = modes.find((m) => m.value === mode) || modes[0];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs border border-border-subtle hover:bg-hover transition-colors ${current.color}`}
      >
        <span className="truncate max-w-[50px]">{current.label}</span>
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 min-w-[120px] bg-input border border-border-input rounded-md shadow-lg z-50 py-0.5 animate-slide-up">
          {modes.map((m) => (
            <button
              key={m.value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={`w-full text-right px-2.5 py-1 text-2xs hover:bg-hover transition-colors ${m.value === mode ? 'text-brand font-medium' : 'text-text-secondary'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── Model selector ── */

const ModelSelector: React.FC<{
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
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs bg-elevated border border-border-subtle text-text-muted hover:text-text-secondary hover:bg-hover transition-colors"
        title={currentModel?.label ?? t('model.switch')}
      >
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
        </svg>
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 min-w-[160px] max-w-[220px] bg-input border border-border-input rounded-md shadow-lg z-50 py-0.5 animate-slide-up">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`w-full text-right px-2.5 py-1 text-2xs hover:bg-hover transition-colors ${m.id === current ? 'text-brand font-medium' : 'text-text-secondary'}`}
            >
              <div className="truncate">{m.label}</div>
              {m.description && (
                <div className="text-text-muted truncate">{m.description}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── Auto-approve selector ── */

const AutoApproveSelector: React.FC<{
  mode: AutoApproveMode;
  onChange: (mode: AutoApproveMode) => void;
  t: (k: string) => string;
}> = ({ mode, onChange, t }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const modes: { value: AutoApproveMode; label: string }[] = [
    { value: 'none', label: t('autoApprove.none') },
    { value: 'read-only', label: t('autoApprove.readOnly') },
    { value: 'all', label: t('autoApprove.all') },
  ];

  const current = modes.find((m) => m.value === mode) || modes[0];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs border border-border-subtle hover:bg-hover transition-colors text-text-muted"
        title={t('chat.autoApprove')}
      >
        <span className="truncate max-w-[80px]">{current.label}</span>
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 min-w-[140px] bg-input border border-border-input rounded-md shadow-lg z-50 py-0.5 animate-slide-up">
          {modes.map((m) => (
            <button
              key={m.value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={`w-full text-right px-2.5 py-1 text-2xs hover:bg-hover transition-colors ${m.value === mode ? 'text-brand font-medium' : 'text-text-secondary'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
