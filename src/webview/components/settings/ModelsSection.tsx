import React from 'react';
import type { AgentConfig, AgentMode } from '@shared/index';
import { Section, SettingRow, Select, TextInput } from './ui';

const MODES: AgentMode[] = ['coding', 'plan', 'ask', 'debug', 'auto'];

export const ModelsSection: React.FC<{
  config: AgentConfig;
  modelAssignments: Record<AgentMode, string>;
  onAssignmentsChange: (v: Record<AgentMode, string>) => void;
  t: (k: string) => string;
}> = ({ config, modelAssignments, onAssignmentsChange, t }) => {
  const models = config.providers?.flatMap((p) => p.models).filter(Boolean) ?? [];

  return (
    <div className="space-y-8">
      {/* Per-mode model assignment */}
      <Section title={t('models.perMode')}>
        {MODES.map((mode) => (
          <SettingRow key={mode} label={t(`models.${mode}`)}>
            <Select
              value={modelAssignments[mode] || config.defaultModel}
              onChange={(v) => onAssignmentsChange({ ...modelAssignments, [mode]: v })}
              options={models.map((m) => ({ value: m.id, label: m.label }))}
              className="min-w-[140px]"
            />
          </SettingRow>
        ))}
      </Section>

      {/* Default model */}
      <Section title={t('settings.model')}>
        <SettingRow label={t('settings.defaultModel')}>
          <TextInput value={config.defaultModel} readOnly />
        </SettingRow>
        <SettingRow label={t('settings.professionalModel')}>
          <TextInput value={config.professionalModel} readOnly />
        </SettingRow>
      </Section>

      {/* Available models list */}
      <Section title={t('models.available')}>
        {models.length === 0 ? (
          <div className="text-xs text-text-tertiary bg-input rounded-card p-3 border border-border-subtle">
            {t('models.noModels')}
          </div>
        ) : (
          <div className="space-y-1">
            {models.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-xs px-2.5 py-2 bg-input rounded-card border border-border-subtle">
                <div className="min-w-0 flex-1">
                  <span className="text-text-primary font-medium">{m.label}</span>
                  {m.description && (
                    <span className="text-text-muted text-2xs block">{m.description}</span>
                  )}
                </div>
                <span className="text-text-tertiary text-2xs shrink-0">{m.id}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
