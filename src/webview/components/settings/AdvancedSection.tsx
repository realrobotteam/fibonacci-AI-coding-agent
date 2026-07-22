import React, { useState, useEffect } from 'react';
import type { AgentConfig, ContextCompression } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, SettingRow, Select, Button, TextInput } from './ui';

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
    postToHost({ type: 'EXPORT_SETTINGS' });
    // The export data will come back via SETTINGS_EXPORT event
    // For now, we'll trigger a download after a brief delay
    setTimeout(() => {
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
    }, 100);
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
          <div className="flex gap-2">
            <Button variant="secondary" onClick={downloadExport} className="flex-1">
              {t('advanced.export')}
            </Button>
            <Button variant="secondary" onClick={handleFileImport} className="flex-1">
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
