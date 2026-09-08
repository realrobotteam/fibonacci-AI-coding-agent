import React from 'react';
import type { AgentConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, SettingRow, Toggle, Select, IconButton } from './ui';

/** External-link icon for the "open VS Code settings" action. */
const ExternalLinkIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M6.5 3.5H3.7a1.2 1.2 0 0 0-1.2 1.2v7.6a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2V9.5" />
    <path d="M9.5 2.5h4v4M13.2 2.8 7.5 8.5" />
  </svg>
);

export const GeneralSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const set = (key: string, value: unknown) => {
    postToHost({ type: 'SET_CONFIG', key, value });
  };

  return (
    <div className="space-y-8">
      {/* UI Language */}
      <Section title={t('settings.appearance')}>
        <SettingRow label={t('settings.language')}>
          <Select
            value={config.language}
            onChange={(v) => set('language', v)}
            options={[
              { value: 'fa', label: 'فارسی' },
              { value: 'en', label: 'English' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label={t('settings.themeBehavior')}
          description={t('settings.themeBehavior.desc')}
        >
          <Select
            value={config.themeBehavior ?? 'auto'}
            onChange={(v) => set('themeBehavior', v)}
            options={[
              { value: 'auto', label: t('settings.theme.auto') },
              { value: 'dark', label: t('settings.theme.dark') },
              { value: 'light', label: t('settings.theme.light') },
            ]}
          />
        </SettingRow>
        <SettingRow
          label={t('settings.uiStyle') || 'UI Style'}
          description={t('settings.uiStyle.desc') || 'Choose between default and neomorphism design'}
        >
          <Select
            value={config.uiStyle ?? 'default'}
            onChange={(v) => set('uiStyle', v)}
            options={[
              { value: 'default', label: t('settings.uiStyle.default') || 'Default' },
              { value: 'neomorphism', label: t('settings.uiStyle.neomorphism') || 'Neomorphism' },
            ]}
          />
        </SettingRow>
      </Section>

      {/* Behavior */}
      <Section title={t('settings.behavior')}>
        <SettingRow label={t('settings.showReasoning')}>
          <Toggle checked={config.showReasoning} onChange={(v) => set('showReasoning', v)} />
        </SettingRow>
        <SettingRow
          label={t('settings.autoDiagnostics')}
          description={t('settings.autoDiagnostics.desc')}
        >
          <Toggle checked={config.autoDiagnostics ?? true} onChange={(v) => set('autoDiagnostics', v)} />
        </SettingRow>
        <SettingRow
          label={t('settings.repoMap')}
          description={t('settings.repoMap.desc')}
        >
          <Toggle checked={config.repoMap ?? true} onChange={(v) => set('repoMap', v)} />
        </SettingRow>
        <SettingRow
          label={t('settings.ghostText')}
          description={t('settings.ghostText.desc')}
        >
          <Toggle checked={config.ghostText ?? false} onChange={(v) => set('ghostText', v)} />
        </SettingRow>
      </Section>

      {/* Startup & Notifications */}
      <Section title={t('settings.startup')}>
        <SettingRow label={t('settings.startupView')}>
          <Select
            value={config.startupView ?? 'last-chat'}
            onChange={(v) => set('startupView', v)}
            options={[
              { value: 'last-chat', label: t('settings.startup.lastChat') },
              { value: 'home', label: t('settings.startup.home') },
            ]}
          />
        </SettingRow>
        <SettingRow label={t('settings.notifyOnTaskComplete')}>
          <Toggle checked={config.notifyOnTaskComplete ?? true} onChange={(v) => set('notifyOnTaskComplete', v)} />
        </SettingRow>
      </Section>

      <div className="flex justify-center">
        <IconButton
          icon={<ExternalLinkIcon />}
          label={t('settings.openVSCode')}
          onClick={() => postToHost({ type: 'OPEN_SETTINGS' })}
        />
      </div>
    </div>
  );
};
