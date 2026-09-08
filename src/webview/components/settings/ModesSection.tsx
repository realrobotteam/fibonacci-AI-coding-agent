import React, { useEffect, useState } from 'react';
import type { AgentConfig, CustomMode } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { useStore } from '../../store/useStore';
import { fill } from '../../lib/format';
import { Section, EmptyState, TextInput, Button } from './ui';

/** Built-in mode ids a custom id must not collide with. */
const BUILTIN_IDS = ['coding', 'plan', 'ask', 'debug', 'auto'];
const MAX_CUSTOM_MODES = 20;
/** CustomMode.id is documented as [a-z0-9-]{1,32}; keep room for "-2" style suffixes. */
const MAX_ID_LEN = 32;

interface DraftState {
  /** null while creating a new mode; the existing id while editing (upsert). */
  editingId: string | null;
  name: string;
  icon: string;
  prompt: string;
  tools: string[];
}

const EMPTY_DRAFT: DraftState = { editingId: null, name: '', icon: '🧩', prompt: '', tools: [] };

/** Lowercase latin/digits/dashes slug from a display name (any language). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LEN - 4); // headroom for uniqueness suffixes
  return base || `mode-${Date.now().toString(36)}`;
}

export const ModesSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const toolList = useStore((s) => s.toolList).filter((tool) => !tool.hidden);
  const setNotice = useStore((s) => s.setNotice);
  const customModes = config.customModes ?? [];

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The tool whitelist needs the registry list — ask the host directly so the
  // section works even if the Permissions tab was never opened.
  useEffect(() => {
    postToHost({ type: 'GET_TOOL_LIST' });
  }, []);

  const openAdd = () => {
    setError(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const openEdit = (m: CustomMode) => {
    setError(null);
    setDraft({
      editingId: m.id,
      name: m.name,
      icon: m.icon,
      prompt: m.prompt,
      tools: m.tools ? [...m.tools] : [],
    });
  };

  const closeForm = () => {
    setError(null);
    setDraft(null);
  };

  const toggleTool = (name: string) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            tools: d.tools.includes(name) ? d.tools.filter((x) => x !== name) : [...d.tools, name],
          }
        : d
    );
  };

  /** Client-side id: unique slug vs built-ins + existing customs. */
  const makeId = (name: string): string => {
    const taken = new Set<string>([...BUILTIN_IDS, ...customModes.map((m) => m.id)]);
    const base = slugify(name);
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name || !prompt) {
      setError(t('modes.error.required'));
      return;
    }
    // The cap only applies to NEW modes (editing is an upsert).
    if (draft.editingId === null && customModes.length >= MAX_CUSTOM_MODES) {
      setNotice(t('modes.limitReached'));
      return;
    }
    const mode: CustomMode = {
      id: draft.editingId ?? makeId(name),
      name,
      icon: draft.icon.trim() || '🧩',
      prompt,
      tools: draft.tools.length > 0 ? [...draft.tools] : undefined,
    };
    // No optimistic config mutation — the host persists and pushes CONFIG back.
    postToHost({ type: 'SAVE_CUSTOM_MODE', mode });
    setNotice(t('modes.saved'));
    setDraft(null);
  };

  const remove = (m: CustomMode) => {
    if (!window.confirm(fill(t('modes.deleteConfirm'), { name: m.name }))) return;
    postToHost({ type: 'DELETE_CUSTOM_MODE', id: m.id });
    if (draft?.editingId === m.id) setDraft(null);
    setNotice(fill(t('modes.deleted'), { name: m.name }));
  };

  return (
    <div className="space-y-8">
      <Section title={t('modes.title')}>
        <p className="text-2xs text-text-muted leading-relaxed">{t('modes.desc')}</p>
        <div className="space-y-2">
          <div>
            <Button variant="primary" onClick={openAdd} disabled={customModes.length >= MAX_CUSTOM_MODES}>
              + {t('modes.add')}
            </Button>
          </div>

          {customModes.length === 0 ? (
            <EmptyState message={t('modes.empty')} />
          ) : (
            <div className="space-y-2">
              {customModes.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-2 px-3 py-2.5 bg-input rounded-card border border-border-subtle hover:border-border-input transition-colors duration-fast"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-base leading-none shrink-0" role="img" aria-label={m.name}>
                      {m.icon}
                    </span>
                    <div className="min-w-0">
                      <span className="text-xs font-medium text-text-primary truncate block">{m.name}</span>
                      <span className="text-2xs text-text-muted truncate block" dir="ltr">
                        /{m.id} · {m.tools?.length ? `${t('modes.tools')}: ${m.tools.length}` : t('modes.allTools')}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEdit(m)}
                      title={t('common.edit')}
                      aria-label={`${t('common.edit')}: ${m.name}`}
                      className="w-6 h-6 flex items-center justify-center rounded-sm text-text-muted hover:text-text-primary hover:bg-hover transition-colors duration-fast"
                    >
                      <IconPencil />
                    </button>
                    <button
                      onClick={() => remove(m)}
                      title={t('modes.delete')}
                      aria-label={`${t('modes.delete')}: ${m.name}`}
                      className="w-6 h-6 flex items-center justify-center rounded-sm text-text-muted hover:text-status-error hover:bg-hover transition-colors duration-fast"
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {/* Inline add/edit form */}
      {draft && (
        <Section title={draft.editingId ? t('modes.editTitle') : t('modes.addTitle')}>
          <div className="space-y-3 border border-border-subtle rounded-card bg-input p-3">
            <div className="flex flex-col min-[480px]:flex-row gap-3">
              <div className="flex-1 min-w-0">
                <label className="text-2xs text-text-secondary block mb-1">{t('modes.name')}</label>
                <TextInput
                  value={draft.name}
                  onChange={(v) => setDraft((d) => (d ? { ...d, name: v } : d))}
                  placeholder={t('modes.namePlaceholder')}
                />
              </div>
              <div className="w-28 shrink-0">
                <label className="text-2xs text-text-secondary block mb-1">{t('modes.icon')}</label>
                <TextInput
                  value={draft.icon}
                  onChange={(v) => setDraft((d) => (d ? { ...d, icon: v } : d))}
                  maxLength={4}
                  className="text-center"
                />
              </div>
            </div>

            <div>
              <label className="text-2xs text-text-secondary block mb-1">{t('modes.prompt')}</label>
              <textarea
                value={draft.prompt}
                onChange={(e) => setDraft((d) => (d ? { ...d, prompt: e.target.value } : d))}
                rows={4}
                placeholder={t('modes.promptPlaceholder')}
                className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast resize-y placeholder:text-text-muted"
              />
            </div>

            <div>
              <label className="text-2xs text-text-secondary block mb-1">{t('modes.tools')}</label>
              {toolList.length === 0 ? (
                <div className="text-2xs text-text-muted">{t('modes.noTools')}</div>
              ) : (
                <div className="max-h-40 overflow-y-auto bg-panel border border-border-subtle rounded-card p-2 space-y-0.5">
                  {toolList.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-center gap-2 text-2xs text-text-secondary py-0.5 px-1 rounded-sm hover:bg-hover cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={draft.tools.includes(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                        className="shrink-0"
                      />
                      <span className="font-mono truncate min-w-0" dir="ltr">
                        {tool.name}
                      </span>
                      <span className="text-text-muted ms-auto shrink-0">{tool.category}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="text-2xs text-text-muted mt-1">{t('modes.toolsHint')}</div>
            </div>

            {error && <div className="text-2xs text-status-error">{error}</div>}

            <div className="flex items-center gap-1.5">
              <Button variant="primary" onClick={save}>
                {t('common.save')}
              </Button>
              <Button variant="secondary" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
};

/* ── 16×16 stroke icons (same vocabulary as the other settings sections) ── */

const IconPencil: React.FC = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.3 2.2a1.4 1.4 0 0 1 2 2L6 11.5l-2.8.7.7-2.8 7.4-7.2z" />
    <path d="M10.2 3.3l2 2" />
  </svg>
);

const IconTrash: React.FC = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 8.3a1.3 1.3 0 0 0 1.3 1.2h4a1.3 1.3 0 0 0 1.3-1.2l.7-8.3" />
    <path d="M6.6 7v4.3M9.4 7v4.3" />
  </svg>
);
