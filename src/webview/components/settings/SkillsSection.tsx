import React, { useEffect, useRef, useState } from 'react';
import type { AgentConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { useStore } from '../../store/useStore';
import { Section, EmptyState, TextInput, Button } from './ui';

/** Row shape as pushed by the host's SKILLS message (source/repoUrl optional). */
type SkillRow = {
  name: string;
  description: string;
  category: string;
  source?: 'builtin' | 'github';
  repoUrl?: string;
};

const GITHUB_URL_RE = /^https:\/\/(www\.)?(github\.com|raw\.githubusercontent\.com)\//i;

export const SkillsSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const skills = useStore((s) => s.skills) as SkillRow[];
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  // GitHub installer state
  const [repoUrl, setRepoUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [urlError, setUrlError] = useState(false);
  // FIX (install feedback): install completion used to be inferred by watching
  // skills.length — which never changes when re-installing an existing skill
  // (update) and stays unchanged when the install FAILS, so the button stayed
  // stuck on "installing…" until a 12s backstop. The host now acknowledges
  // every outcome with SKILL_INSTALL_RESULT; the UI resolves from that and
  // surfaces inline error/success feedback.
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    postToHost({ type: 'GET_SKILLS' });
  }, []);

  const install = () => {
    const trimmed = repoUrl.trim();
    if (!GITHUB_URL_RE.test(trimmed)) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    setFeedback(null);
    setInstalling(true);
    postToHost({ type: 'ADD_SKILL_FROM_GITHUB', url: trimmed });
  };

  const showFeedback = (kind: 'error' | 'success', text: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback({ kind, text });
    // Success notes self-dismiss; errors stay until the next attempt.
    if (kind === 'success') {
      feedbackTimer.current = setTimeout(() => setFeedback(null), 4000);
    }
  };

  // Resolve "installing" from the host's explicit SKILL_INSTALL_RESULT ack.
  useEffect(() => {
    const onResult = (e: Event) => {
      const detail = (e as CustomEvent<{ ok: boolean; name?: string; error?: string }>).detail;
      setInstalling(false);
      if (detail.ok) {
        setRepoUrl('');
        showFeedback('success', t('skills.github.success'));
      } else {
        // Keep the URL in the field so the user can correct it.
        if (detail.error === 'not-found') {
          showFeedback('error', t('skills.github.notFound'));
        } else if (detail.error === 'builtin-collision') {
          showFeedback('error', t('skills.github.collision'));
        } else {
          showFeedback('error', `${t('skills.github.failed')}${detail.error ? ` — ${detail.error}` : ''}`);
        }
      }
    };
    window.addEventListener('SKILL_INSTALL_RESULT', onResult);
    return () => {
      window.removeEventListener('SKILL_INSTALL_RESULT', onResult);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Backstop: never leave the button in a loading state forever (e.g. the
  // host died mid-install and no result will ever arrive).
  useEffect(() => {
    if (!installing) return;
    const id = setTimeout(() => {
      setInstalling(false);
    }, 12000);
    return () => clearTimeout(id);
  }, [installing]);

  const removeSkill = (name: string) => {
    postToHost({ type: 'REMOVE_CUSTOM_SKILL', name });
    postToHost({ type: 'GET_SKILLS' });
  };

  return (
    <div className="space-y-6">
      {/* Install from GitHub */}
      <Section title={t('skills.github.title')}>
        <div className="space-y-2">
          <p className="text-2xs text-text-muted leading-relaxed">{t('skills.github.desc')}</p>
          <div className="flex flex-col min-[480px]:flex-row gap-1.5">
            <TextInput
              value={repoUrl}
              onChange={(v) => { setRepoUrl(v); setUrlError(false); }}
              placeholder={t('skills.github.placeholder')}
              dir="ltr"
              className="min-[480px]:flex-1"
            />
            <Button
              variant="primary"
              onClick={install}
              disabled={installing || !repoUrl.trim()}
              className="min-[480px]:shrink-0 min-[480px]:w-24"
            >
              {installing ? t('skills.installing') : t('skills.install')}
            </Button>
          </div>
          {urlError && (
            <div className="text-2xs text-status-error">{t('skills.invalidUrl')}</div>
          )}
          {feedback && (
            <div
              role="status"
              className={`text-2xs leading-relaxed ${feedback.kind === 'error' ? 'text-status-error' : 'text-status-success'}`}
            >
              {feedback.text}
            </div>
          )}
        </div>
      </Section>

      {/* Installed skills */}
      <Section title={t('skills.title')}>
        {skills.length === 0 ? (
          <EmptyState message={t('skills.empty') || 'No skills installed'} />
        ) : (
          <div className="space-y-2">
            {skills.map((s) => {
              const fromGithub = s.source === 'github';
              const expanded = expandedSkill === s.name;
              return (
                <div key={s.name} className="border border-border-subtle rounded-card bg-input overflow-hidden hover:border-border-input transition-colors duration-fast">
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-elevated-2/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.8 1.9l1.05 2.5 2.5 1.05-2.5 1.05L9.8 9l-1.05-2.5-2.5-1.05 2.5-1.05L9.8 1.9z" />
                      </svg>
                      <div className="min-w-0">
                        <span className="font-medium text-sm truncate block">{s.name}</span>
                        <span className="text-2xs text-text-tertiary capitalize">{s.category}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {fromGithub ? (
                        <span className="inline-flex items-center gap-1 text-2xs text-[#A78BFA] bg-[#7C3AED]/15 border border-[#7C3AED]/30 rounded px-1.5 py-px">
                          <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="4.5" cy="4" r="1.6" />
                            <circle cx="4.5" cy="12" r="1.6" />
                            <circle cx="11.5" cy="6.5" r="1.6" />
                            <path d="M4.5 5.6v4.8M6.1 5.1l3.7 1.1" />
                          </svg>
                          {t('skills.source.github')}
                        </span>
                      ) : (
                        <span className="text-2xs text-text-muted bg-elevated-2 border border-border-subtle rounded px-1.5 py-px">
                          {t('skills.source.builtin')}
                        </span>
                      )}
                      {fromGithub && (
                        <button
                          onClick={() => removeSkill(s.name)}
                          title={t('skills.remove')}
                          aria-label={t('skills.remove')}
                          className="text-text-muted hover:text-status-error transition-colors duration-fast p-0.5"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M2.5 4.5h11M6.5 2.5h3M4 4.5l.7 8.3a1.3 1.3 0 0 0 1.3 1.2h4a1.3 1.3 0 0 0 1.3-1.2l.7-8.3" />
                            <path d="M6.6 7v4.3M9.4 7v4.3" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => setExpandedSkill(expanded ? null : s.name)}
                        className="text-2xs text-text-muted hover:text-text-primary transition-colors px-1 whitespace-nowrap"
                      >
                        {expanded ? (t('common.collapse') || 'Hide') : t('skills.viewBody')}
                      </button>
                    </div>
                  </div>
                  <div className="px-3 py-2 text-2xs text-text-tertiary border-t border-border-subtle">
                    {s.description}
                  </div>
                  {expanded && (
                    <div className="px-3 py-2 border-t border-border-subtle space-y-2 bg-panel">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-2xs text-text-muted">{t('skills.category') || 'Category'}:</span>
                        <span className="text-2xs text-text-secondary bg-elevated-2 px-1.5 py-0.5 rounded capitalize">{s.category}</span>
                        <span className="text-2xs text-text-muted bg-elevated-2 border border-border-subtle px-1.5 py-0.5 rounded">
                          {fromGithub ? t('skills.source.github') : t('skills.source.builtin')}
                        </span>
                      </div>
                      {fromGithub && s.repoUrl && (
                        <div className="text-2xs" dir="ltr">
                          <span className="text-status-info underline break-all">{s.repoUrl}</span>
                        </div>
                      )}
                      {s.description && (
                        <div className="text-2xs text-text-tertiary whitespace-pre-wrap max-h-40 overflow-y-auto bg-panel rounded p-1.5 leading-relaxed">
                          {s.description}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
};
