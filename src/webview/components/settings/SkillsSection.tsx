import React, { useState, useEffect } from 'react';
import type { AgentConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { useStore } from '../../store/useStore';
import { Section, Toggle, EmptyState } from './ui';

export const SkillsSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const skills = useStore((s) => s.skills);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  useEffect(() => {
    postToHost({ type: 'GET_SKILLS' });
  }, []);

  return (
    <div className="space-y-6">
      <Section title={t('skills.title')}>
        {skills.length === 0 ? (
          <EmptyState message={t('skills.empty') || 'No skills installed'} />
        ) : (
          <div className="space-y-2">
            {skills.map((s) => (
              <div key={s.name} className="border border-border-subtle rounded-card bg-input overflow-hidden hover:border-border-input transition-colors duration-fast">
                <div className="flex items-center justify-between px-3 py-2.5 bg-elevated-2/40">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5l2-5z" />
                    </svg>
                    <div>
                      <span className="font-medium text-sm truncate block">{s.name}</span>
                      <span className="text-2xs text-text-tertiary capitalize">{s.category}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => setExpandedSkill(expandedSkill === s.name ? null : s.name)}
                      className="text-2xs text-text-muted hover:text-text-primary transition-colors px-1"
                    >
                      {expandedSkill === s.name ? t('common.collapse') : t('common.expand')}
                    </button>
                  </div>
                </div>
                <div className="px-3 py-2 text-2xs text-text-tertiary border-t border-border-subtle">
                  {s.description}
                </div>
                {expandedSkill === s.name && (
                  <div className="px-3 py-2 border-t border-border-subtle">
                    <div className="text-2xs text-text-muted mb-1">{t('skills.category') || 'Category'}:</div>
                    <span className="text-xs text-text-secondary bg-elevated-2 px-2 py-0.5 rounded">{s.category}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
