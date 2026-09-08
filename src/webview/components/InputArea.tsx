import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { buildModeTag, ModelChoice } from '@shared';
import type { AgentMode, AutoApproveMode, CustomMode } from '@shared/index';
import { postMessage as postToHost } from '../vscodeApi';
import { fill } from '../lib/format';

/** One row of the slash/mention popup. */
interface PopupItem {
  key: string;
  /** Literal text shown, e.g. '/plan' or '@src/app.ts'. */
  title: string;
  /** Secondary description line. */
  hint?: string;
  apply: () => void;
}

const MODE_COMMANDS: AgentMode[] = ['plan', 'coding', 'ask', 'debug', 'auto'];

/** Vision input limits — max pending attachments, max data-URL length each. */
const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_CHARS = 6_000_000;

/** A token right before the caret that started with '@'. */
const MENTION_RE = /@[\w./\\-]*$/;

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
  const composerDraft = useStore((s) => s.composerDraft);
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const workspaceFiles = useStore((s) => s.workspaceFiles);
  const setNotice = useStore((s) => s.setNotice);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  // Escape closes the popup until the text changes again.
  const [popupDismissed, setPopupDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showImproved, setShowImproved] = useState<string | null>(null);
  // Pending image attachments (data URLs) for vision input.
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // Mirror of the list for async FileReader callbacks — several loads can
  // resolve in sequence and a closure over `pendingImages` would be stale.
  const pendingImagesRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const updateText = (next: string) => {
    setText(next);
    setPopupDismissed(false);
    setActiveIndex(0);
  };

  useEffect(() => {
    if (editingText !== null) {
      setText(editingText);
      ref.current?.focus();
    }
  }, [editingText]);

  // Home-page example chips: consume the pending draft once, prefill the
  // composer and focus it (distinct from edit mode — no EDIT_USER_MESSAGE).
  useEffect(() => {
    if (composerDraft !== null) {
      setText(composerDraft);
      setComposerDraft(null);
      ref.current?.focus();
    }
  }, [composerDraft, setComposerDraft]);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px';
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

  /* ── Vision input (paste / attach) ── */

  const addPendingImage = (dataUrl: string) => {
    if (!dataUrl.startsWith('data:image/')) return;
    if (dataUrl.length > MAX_IMAGE_CHARS) {
      setNotice(t('vision.tooLarge'));
      return;
    }
    if (pendingImagesRef.current.length >= MAX_PENDING_IMAGES) {
      setNotice(t('vision.tooMany'));
      return;
    }
    pendingImagesRef.current = [...pendingImagesRef.current, dataUrl];
    setPendingImages(pendingImagesRef.current);
  };

  const addImageFiles = (files: Array<File | null>) => {
    for (const file of files) {
      if (!file || !file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') addPendingImage(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const removePendingImage = (index: number) => {
    pendingImagesRef.current = pendingImagesRef.current.filter((_, i) => i !== index);
    setPendingImages(pendingImagesRef.current);
  };

  const clearPendingImages = () => {
    pendingImagesRef.current = [];
    setPendingImages([]);
  };

  // Image files pasted into the textarea become pending attachment chips.
  const onPasteImages = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isBusy) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    // Only swallow the paste when it actually carries images — text must
    // keep its default paste behavior.
    if (files.length > 0) {
      e.preventDefault();
      addImageFiles(files);
    }
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;

    // A bare slash command is executed locally — it must never reach the host
    // as a chat message (even with the palette dismissed via Escape).
    // Custom mode ids are slugs ([a-z0-9-]) so the match must accept dashes.
    if (trimmed.startsWith('/')) {
      const match = /^\/([\w-]+)$/.exec(trimmed);
      const cmd = match
        ? buildSlashCommands().find((it) => it.title === `/${match[1].toLowerCase()}`)
        : undefined;
      if (cmd) {
        cmd.apply();
        return;
      }
    }

    // Edit mode: the host truncates its history at the previous user message
    // and re-runs — no client-side splicing; the host applies the mode tag.
    if (editingText !== null) {
      postToHost({
        type: 'EDIT_USER_MESSAGE',
        previousText: editingText,
        newText: trimmed,
        mode: agentMode,
      });
      setText('');
      // EDIT_USER_MESSAGE carries no images — keep pending ones from silently
      // attaching to a later, unrelated send.
      clearPendingImages();
      setShowImproved(null);
      cancelEdit();
      return;
    }

    postToHost({
      type: 'SEND_MESSAGE',
      text: buildModeTag(agentMode) + trimmed,
      images: pendingImages.length > 0 ? pendingImages : undefined,
    });
    setText('');
    clearPendingImages();
    setShowImproved(null);
    cancelEdit();
  };

  const cancel = () => postToHost({ type: 'CANCEL' });

  const onKey = (e: React.KeyboardEvent) => {
    if (popupItems.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((i) => (i + delta + popupItems.length) % popupItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        popupItems[clampedIndex]?.apply();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopupDismissed(true);
        return;
      }
    }
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

  // ── Slash palette / @mention popup state ──

  const slashActive = text.startsWith('/');
  const mentionMatch = useMemo(() => MENTION_RE.exec(text.slice(0, caret)), [text, caret]);
  const mentionActive = !slashActive && mentionMatch !== null;
  const mentionToken = mentionMatch?.[0] ?? '';
  const mentionQuery = mentionToken.slice(1).toLowerCase();

  const customModes: CustomMode[] = config?.customModes ?? [];

  // Display label for the pickers: custom modes show "icon + name", built-ins
  // keep their translated label.
  const modeLabel = (mode: AgentMode) => {
    const custom = customModes.find((m) => m.id === mode);
    return custom ? `${custom.icon} ${custom.name}` : t(`mode.${mode}`);
  };

  // Same switch path as the slash palette: optimistic store update + host
  // persist (fibonacci.agentMode); the mode tag is still attached per-message.
  const changeMode = (mode: AgentMode) => {
    setAgentMode(mode);
    postToHost({ type: 'SET_AGENT_MODE', mode });
  };

  // All available slash commands (unfiltered) — also used by send()'s guard so
  // slash text is never leaked to the host as a chat message.
  const buildSlashCommands = (): PopupItem[] => {
    const notice = (key: string, params?: Record<string, string | number>) =>
      useStore.getState().setNotice(params ? fill(t(key), params) : t(key));
    const items: PopupItem[] = MODE_COMMANDS.map((mode) => ({
      key: `mode:${mode}`,
      title: `/${mode}`,
      hint: fill(t('slash.mode'), { mode: modeLabel(mode) }),
      apply: () => {
        setAgentMode(mode);
        postToHost({ type: 'SET_AGENT_MODE', mode });
        notice('slash.modeSwitched', { mode: modeLabel(mode) });
        updateText('');
      },
    }));
    // One dynamic entry per user-defined mode — same switch path as built-ins.
    for (const cm of customModes) {
      items.push({
        key: `mode:custom:${cm.id}`,
        title: `/${cm.id}`,
        hint: fill(t('slash.mode'), { mode: modeLabel(cm.id) }),
        apply: () => {
          setAgentMode(cm.id);
          postToHost({ type: 'SET_AGENT_MODE', mode: cm.id });
          notice('slash.modeSwitched', { mode: modeLabel(cm.id) });
          updateText('');
        },
      });
    }
    items.push({
      key: 'cmd:compact',
      title: '/compact',
      hint: t('slash.compact'),
      apply: () => {
        useStore.getState().setCondensing(true);
        postToHost({ type: 'CONDENSE_CONTEXT' });
        updateText('');
      },
    });
    items.push({
      key: 'cmd:clear',
      title: '/clear',
      hint: t('slash.clear'),
      apply: () => {
        postToHost({ type: 'NEW_CHAT' });
        updateText('');
      },
    });
    items.push({
      key: 'cmd:export',
      title: '/export',
      hint: t('slash.export'),
      apply: () => {
        postToHost({ type: 'EXPORT_CHAT' });
        updateText('');
      },
    });
    return items;
  };

  const slashItems = useMemo<PopupItem[]>(() => {
    if (!slashActive || popupDismissed || isBusy) return [];
    const query = text.slice(1).toLowerCase();
    return buildSlashCommands().filter((it) => it.title.slice(1).startsWith(query));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashActive, popupDismissed, isBusy, text, t, setAgentMode, agentMode, customModes]);

  // Replace the '@token' before the caret with '@<value> ' and put the caret
  // after the inserted text.
  const applyMention = (value: string) => {
    const el = ref.current;
    const pos = el?.selectionStart ?? text.length;
    const start = pos - mentionToken.length;
    const inserted = `@${value} `;
    setText((prev) => prev.slice(0, start) + inserted + prev.slice(pos));
    setPopupDismissed(false);
    setActiveIndex(0);
    const newPos = start + inserted.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(newPos, newPos);
    });
  };

  const mentionItems = useMemo<PopupItem[]>(() => {
    if (!mentionActive || popupDismissed || isBusy) return [];
    const items: PopupItem[] = [];
    if (mentionQuery === '' || 'problems'.startsWith(mentionQuery) || 'git'.startsWith(mentionQuery)) {
      items.push(
        { key: 'static:@problems', title: '@problems', hint: t('mentions.hint'), apply: () => applyMention('problems') },
        { key: 'static:@git', title: '@git', hint: t('mentions.hint'), apply: () => applyMention('git') }
      );
    }
    const files = workspaceFiles
      .filter((f) => f.toLowerCase().includes(mentionQuery))
      .slice(0, 8);
    for (const f of files) {
      items.push({ key: `file:${f}`, title: `@${f}`, apply: () => applyMention(f) });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionActive, popupDismissed, isBusy, mentionQuery, mentionToken, workspaceFiles, t, text, caret]);

  // Debounced workspace file search while a mention is being typed.
  useEffect(() => {
    if (!mentionActive) return;
    if (mentionToken === '@problems' || mentionToken === '@git') return;
    const timer = setTimeout(() => {
      postToHost({ type: 'SEARCH_WORKSPACE_FILES', query: mentionToken });
    }, 220);
    return () => clearTimeout(timer);
  }, [mentionActive, mentionToken]);

  const showSlashPopup = slashActive && !popupDismissed && slashItems.length > 0;
  const showMentionPopup = mentionActive && !popupDismissed;
  const popupItems = showSlashPopup ? slashItems : showMentionPopup ? mentionItems : [];
  const clampedIndex = popupItems.length > 0 ? Math.min(activeIndex, popupItems.length - 1) : 0;

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

      {/* Pending image attachments (vision input) */}
      {pendingImages.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap animate-slide-up">
          {pendingImages.map((img, i) => (
            <div key={`${i}:${img.length}`} className="relative">
              <img
                src={img}
                alt={t('vision.thumbAlt')}
                className="h-14 w-14 rounded-md object-cover border border-border-subtle block"
              />
              <button
                onClick={() => removePendingImage(i)}
                title={t('vision.remove')}
                aria-label={`${t('vision.remove')} (${i + 1})`}
                className="absolute -top-1.5 -end-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-elevated-2 border border-border-input text-text-muted hover:text-status-error hover:border-status-error/40 transition-colors"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
          <span className="text-2xs text-text-muted ms-1">{fill(t('vision.count'), { n: pendingImages.length })}</span>
        </div>
      )}

      {/* Composer — Kilo-style rounded box, brand border on focus */}
      <div className="relative bg-input border border-border-subtle rounded-xl focus-within:border-brand transition-colors">
        {/* Slash / mention popup */}
        {(showSlashPopup || showMentionPopup) && (
          <div
            role="listbox"
            aria-label={showSlashPopup ? 'Commands' : t('mentions.files')}
            className="absolute bottom-full mb-1 left-0 right-0 bg-input border border-border-input rounded-md shadow-lg z-50 py-0.5 max-h-56 overflow-y-auto animate-slide-up"
          >
            {showMentionPopup && (
              <div className="px-2.5 pt-1 pb-0.5 text-2xs text-text-tertiary">{t('mentions.files')}</div>
            )}
            {popupItems.map((item, i) => (
              <button
                key={item.key}
                role="option"
                aria-selected={i === clampedIndex}
                // preventDefault keeps focus in the textarea.
                onMouseDown={(e) => {
                  e.preventDefault();
                  item.apply();
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1 text-right text-2xs transition-colors ${i === clampedIndex ? 'bg-hover text-text-primary' : 'text-text-secondary'}`}
              >
                <span className="font-mono truncate" dir="ltr">{item.title}</span>
                {item.hint && <span className="text-text-muted truncate">{item.hint}</span>}
              </button>
            ))}
            {showMentionPopup && popupItems.length === 0 && (
              <div className="px-2.5 py-1 text-2xs text-text-muted">{t('mentions.noResults')}</div>
            )}
          </div>
        )}

        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            updateText(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKey}
          onPaste={onPasteImages}
          placeholder={isBusy ? t('chat.placeholder.busy') : t('input.placeholderKilo')}
          rows={3}
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

        {/* Bottom toolbar — Kilo: chips at the start, icon cluster at the end */}
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-0.5">
          {/* Start: mode + model chips */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <ModeSelector mode={agentMode} onChange={changeMode} t={t} customModes={customModes} />
            <ModelSelector models={models} current={currentModel} onChange={(id) => postToHost({ type: 'SWITCH_MODEL', modelId: id })} t={t} />
          </div>

          {/* End: auto-approve shield · improve · attach · send */}
          <div className="flex items-center gap-0.5 shrink-0">
            <AutoApproveSelector mode={autoApproveMode} onChange={(m) => postToHost({ type: 'SET_AUTO_APPROVE_MODE', mode: m })} t={t} />
            <button
              onClick={improvePrompt}
              disabled={!text.trim() || isBusy}
              className="relative w-7 h-7 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover disabled:opacity-30 transition-colors after:content-[''] after:absolute after:-inset-2"
              title={t('chat.promptEngineer')}
              aria-label={t('chat.promptEngineer')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                <path d="M20 3v4" />
                <path d="M22 5h-4" />
              </svg>
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
              className="relative w-7 h-7 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover disabled:opacity-30 transition-colors after:content-[''] after:absolute after:-inset-2"
              title={t('vision.attach')}
              aria-label={t('vision.attach')}
            >
              <IconImagePlus />
            </button>
            {isBusy ? (
              <button
                onClick={cancel}
                className="relative w-7 h-7 flex items-center justify-center rounded-sm text-status-error hover:bg-hover transition-colors after:content-[''] after:absolute after:-inset-2"
                title={t('chat.cancel')}
                aria-label={t('chat.cancel')}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!text.trim()}
                className="relative w-7 h-7 flex items-center justify-center rounded-sm text-text-primary hover:bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors after:content-[''] after:absolute after:-inset-2"
                title={t('chat.send')}
                aria-label={t('chat.send')}
              >
                <IconSend />
              </button>
            )}
          </div>
        </div>

        {/* Hidden file picker for the attach button */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addImageFiles(Array.from(e.target.files ?? []));
            // Reset so selecting the same file again still fires onChange.
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
};

/* ── Mode selector (Kilo-style dark chip) ── */

const ModeSelector: React.FC<{
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
  t: (k: string, fallback?: string) => string;
  /** User-defined modes — rendered after the built-ins. */
  customModes: CustomMode[];
}> = ({ mode, onChange, t, customModes }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const modes: { value: AgentMode; label: string }[] = [
    { value: 'coding', label: t('mode.coding') },
    { value: 'plan', label: t('mode.plan') },
    { value: 'ask', label: t('mode.ask') },
    { value: 'debug', label: t('mode.debug') },
    { value: 'auto', label: t('mode.auto') },
  ];
  // User-defined modes — the label already carries the icon ("🧩 Name").
  for (const cm of customModes) {
    modes.push({ value: cm.id, label: `${cm.icon} ${cm.name}` });
  }

  const current = modes.find((m) => m.value === mode) || modes[0];

  // Chip shows the SHORT display name: built-ins map to mode.short.*,
  // custom modes (and anything unknown) fall back to their own name/id.
  const chipLabel = (m: AgentMode): string => {
    const custom = customModes.find((c) => c.id === m);
    return custom ? custom.name : t(`mode.short.${m}`, m);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-elevated text-xs text-text-primary hover:bg-hover transition-colors"
        title={current.label}
        aria-label={fill(t('slash.mode'), { mode: current.label })}
      >
        <span className="truncate max-w-[80px]">{chipLabel(mode)}</span>
        <svg className={`w-2.5 h-2.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
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

/* ── Model selector (Kilo-style dark chip) ── */

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
  const currentLabel = currentModel?.label ?? current;

  return (
    <div ref={ref} className="relative shrink-0 min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-elevated text-xs text-text-primary hover:bg-hover transition-colors"
        title={currentLabel}
        aria-label={`${t('chat.model.label')}: ${currentLabel}`}
      >
        <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
        </svg>
        {/* Show the chosen model name in the toolbar */}
        <span className="truncate max-w-[90px]">{currentLabel}</span>
        <svg className={`w-2.5 h-2.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
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

/* ── Auto-approve cycler (Kilo-style shield + green dot; none → read-only → all → none) ── */

const AUTO_APPROVE_CYCLE: AutoApproveMode[] = ['none', 'read-only', 'all'];

const AUTO_APPROVE_META: Record<AutoApproveMode, { labelKey: string }> = {
  none: { labelKey: 'autoApprove.none' },
  'read-only': { labelKey: 'autoApprove.readOnly' },
  all: { labelKey: 'autoApprove.all' },
};

const AutoApproveSelector: React.FC<{
  mode: AutoApproveMode;
  onChange: (mode: AutoApproveMode) => void;
  t: (k: string) => string;
}> = ({ mode, onChange, t }) => {
  const meta = AUTO_APPROVE_META[mode] ?? AUTO_APPROVE_META.none;
  const next =
    AUTO_APPROVE_CYCLE[(AUTO_APPROVE_CYCLE.indexOf(mode) + 1) % AUTO_APPROVE_CYCLE.length] ?? 'none';
  const enabled = mode !== 'none';
  const stateLabel = `${t('chat.autoApprove')}: ${t(meta.labelKey)}`;

  return (
    <button
      onClick={() => onChange(next)}
      className="relative w-7 h-7 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover transition-colors after:content-[''] after:absolute after:-inset-2"
      title={stateLabel}
      aria-label={stateLabel}
    >
      <IconShield />
      {/* Tiny green dot while auto-approve is enabled (read-only or all) */}
      {enabled && (
        <span className="absolute top-1 end-1 w-1.5 h-1.5 rounded-full bg-status-success" aria-hidden="true" />
      )}
    </button>
  );
};

/* Shield (plain outline) — auto-approve indicator/toggle */

const IconShield = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

/* Paper plane — Kilo-style plain send icon (not a filled square) */

const IconSend = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

/* Image-plus (lucide geometry) — attach-image button */
const IconImagePlus = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
    <line x1="16" y1="5" x2="22" y2="5" />
    <line x1="19" y1="2" x2="19" y2="8" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);
