import React, { useState, useEffect } from 'react';
import type { AgentConfig, ContextCompression } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, SettingRow, Toggle, Select, Button, TextInput } from './ui';

export const AdvancedSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [exportData, setExportData] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      setExportData(e.detail.data);
    };
    window.addEventListener('SETTINGS_EXPORT', handler as EventListener);
    return () => window.removeEventListener('SETTINGS_EXPORT', handler as EventListener);
  }, []);

  const set = (key: string, value: unknown) => {
    postToHost({ type: 'SET_CONFIG', key, value });
  };

  const handleReset = () => {
    postToHost({ type: 'RESET_SETTINGS' });
    setShowResetConfirm(false);
  };

  const handleExport = () => {
    postToHost({ type: 'EXPORT_SETTINGS' });
  };

  const handleImport = () => {
    if (!exportData) return;
    postToHost({ type: 'IMPORT_SETTINGS', data: exportData });
    setExportData(null);
  };

  const downloadExport = () => {
    // FIX (race): register the SETTINGS_EXPORT listener BEFORE posting the
    // request — the host may reply faster than the previous 100ms delay,
    // in which case the reply was missed and no file was downloaded.
    const handler = (e: CustomEvent) => {
      const blob = new Blob([e.detail.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'fibonacci-settings.json';
      a.click();
      URL.revokeObjectURL(url);
      window.removeEventListener('SETTINGS_EXPORT', handler as EventListener);
    };
    window.addEventListener('SETTINGS_EXPORT', handler as EventListener);
    postToHost({ type: 'EXPORT_SETTINGS' });
  };

  const handleFileImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as string;
        postToHost({ type: 'IMPORT_SETTINGS', data });
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <div className="space-y-8">
      {/* Agent behavior */}
      <Section title={t('settings.behavior')}>
        <SettingRow label={t('settings.hermesMode')} description={t('settings.hermesMode.desc')}>
          <Toggle checked={config.hermesMode} onChange={(v) => set('hermesMode', v)} />
        </SettingRow>
        <SettingRow label={t('settings.parallelToolCalls')}>
          <Toggle checked={config.parallelToolCalls} onChange={(v) => set('parallelToolCalls', v)} />
        </SettingRow>
        <SettingRow label={t('settings.maxIterations')}>
          <input
            type="number"
            value={config.maxIterations}
            onChange={(e) => {
              // Clamp to 1..100: the spinner's min/max only guard mouse
              // clicks — typing "0" (or clearing the field to NaN) used to
              // post an invalid value, and maxIterations = 0 makes the agent
              // loop run ZERO iterations (the agent silently does nothing).
              const n = e.target.valueAsNumber;
              if (Number.isInteger(n) && n >= 1 && n <= 100) set('maxIterations', n);
            }}
            min={1}
            max={100}
            className="w-16 bg-panel text-text-primary rounded px-2 py-1 text-xs border border-border-input focus:border-border-focus outline-none"
          />
        </SettingRow>
      </Section>

      {/* Context management */}
      <Section title={t('advanced.contextManagement')}>
        <SettingRow
          label={t('advanced.contextCompression')}
          description={t('advanced.contextCompression.desc')}
        >
          <Select
            value={config.contextCompression ?? 'auto'}
            onChange={(v) => set('contextCompression', v)}
            options={[
              { value: 'auto', label: t('advanced.compression.auto') },
              { value: 'manual', label: t('advanced.compression.manual') },
            ]}
          />
        </SettingRow>
      </Section>

      {/* Chat history */}
      <Section title={t('advanced.history')}>
        <SettingRow label={t('advanced.historyPath')}>
          <TextInput value={config.historyPath ?? '~/.fibonacci/history'} readOnly />
        </SettingRow>
      </Section>

      {/* Import / Export */}
      <Section title={t('advanced.importExport')}>
        <div className="space-y-2">
          <div className="flex flex-col min-[480px]:flex-row gap-2 overflow-x-auto">
            <Button variant="secondary" onClick={downloadExport} className="flex-1 min-w-0">
              {t('advanced.export')}
            </Button>
            <Button variant="secondary" onClick={handleFileImport} className="flex-1 min-w-0">
              {t('advanced.import')}
            </Button>
          </div>
          <p className="text-2xs text-text-muted">{t('advanced.importExport.desc')}</p>
        </div>
      </Section>

      {/* Reset */}
      <Section title={t('advanced.reset')}>
        {!showResetConfirm ? (
          <Button variant="danger" onClick={() => setShowResetConfirm(true)}>
            {t('advanced.resetSettings')}
          </Button>
        ) : (
          <div className="bg-status-error/10 border border-status-error/20 rounded-card p-3 space-y-2">
            <p className="text-xs text-status-error">{t('advanced.resetConfirm')}</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={handleReset}>
                {t('advanced.resetYes')}
              </Button>
              <Button onClick={() => setShowResetConfirm(false)}>
                {t('common.cancel') || 'Cancel'}
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
};
