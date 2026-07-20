import React, { useState, useEffect } from 'react';
import type { AgentConfig, ProviderConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, SettingRow, Toggle, MaskedInput, TextInput, Button, StatusDot, EmptyState, SectionHeader } from './ui';

export const ProvidersSection: React.FC<{
  config: AgentConfig;
  providers: ProviderConfig[];
  onProvidersChange: (v: ProviderConfig[]) => void;
  t: (k: string) => string;
}> = ({ config, providers, onProvidersChange, t }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newProvider, setNewProvider] = useState<ProviderConfig>({
    id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true,
  });
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({});

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { providerId, ok, error } = e.detail;
      setTestResults((prev) => ({ ...prev, [providerId]: { ok, error } }));
    };
    window.addEventListener('PROVIDER_TEST_RESULT', handler as EventListener);
    return () => window.removeEventListener('PROVIDER_TEST_RESULT', handler as EventListener);
  }, []);

  const toggleProvider = (id: string) => {
    onProvidersChange(providers.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  const removeProvider = (id: string) => {
    onProvidersChange(providers.filter((p) => p.id !== id));
  };

  const startEdit = (p: ProviderConfig) => {
    setEditingId(p.id);
    setNewProvider({ ...p });
  };

  const saveEdit = () => {
    if (!newProvider.name || !newProvider.baseURL) return;
    onProvidersChange(providers.map((p) => p.id === editingId ? { ...newProvider } : p));
    setEditingId(null);
    setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true });
  };

  const addProvider = () => {
    if (!newProvider.name || !newProvider.baseURL) return;
    const id = newProvider.name.toLowerCase().replace(/\s+/g, '-');
    onProvidersChange([...providers, { ...newProvider, id }]);
    setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true });
  };

  const testConnection = (id: string) => {
    postToHost({ type: 'TEST_PROVIDER_CONNECTION', providerId: id });
  };

  const editing = editingId ? providers.find((p) => p.id === editingId) : null;

  return (
    <div className="space-y-6">
      {/* Provider list */}
      <Section title={t('providers.title')}>
        {providers.length === 0 ? (
          <EmptyState message={t('providers.empty') || 'No providers configured.'} />
        ) : (
          <div className="space-y-2">
            {providers.map((p) => {
              const test = testResults[p.id];
              return (
                <div key={p.id} className="border border-border-subtle rounded-card bg-input overflow-hidden hover:border-border-input transition-colors duration-fast">
                  <div className="flex items-center justify-between px-3 py-2.5 bg-elevated-2/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M1.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-13zm13-1H1.5a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 14.5 1zM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
                      </svg>
                      <span className="font-medium text-sm truncate">{p.name}</span>
                      {test ? <StatusDot ok={test.ok} /> : <StatusDot ok={p.enabled} />}
                    </div>
                    <div className="flex gap-1 shrink-0 items-center">
                      <Toggle checked={p.enabled} onChange={() => toggleProvider(p.id)} />
                      <Button onClick={() => testConnection(p.id)}>{t('providers.test')}</Button>
                      <Button onClick={() => startEdit(p)}>{t('common.edit') || 'Edit'}</Button>
                      <Button variant="danger" onClick={() => removeProvider(p.id)}>{t('mcp.remove')}</Button>
                    </div>
                  </div>
                  <div className="px-3 py-2 text-2xs text-text-tertiary space-y-1">
                    <div className="truncate" dir="ltr">{p.baseURL}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-text-muted">{t('settings.apiKey')}:</span>
                      <span className="font-mono">{p.apiKey ? '••••••••' : '—'}</span>
                    </div>
                    {p.models.length > 0 && (
                      <div className="text-text-muted">{p.models.map((m) => m.label).join(', ')}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Add/Edit form */}
      <Section title={editing ? (t('common.edit') || 'Edit') : t('providers.add')}>
        <div className="space-y-2">
          <TextInput
            value={newProvider.name}
            onChange={(v) => setNewProvider({ ...newProvider, name: v })}
            placeholder={t('providers.name') || 'Name'}
          />
          <TextInput
            value={newProvider.baseURL}
            onChange={(v) => setNewProvider({ ...newProvider, baseURL: v })}
            placeholder="Base URL (e.g. https://api.openai.com/v1)"
          />
          <div className="flex gap-1.5">
            <MaskedInput
              value={newProvider.apiKey}
              onChange={(v) => setNewProvider({ ...newProvider, apiKey: v })}
              placeholder={t('settings.apiKey') || 'API Key'}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="primary" onClick={editing ? saveEdit : addProvider} disabled={!newProvider.name || !newProvider.baseURL} className="flex-1">
              {editing ? (t('common.save') || 'Save') : (t('providers.add') || 'Add')}
            </Button>
            {editing && (
              <Button onClick={() => { setEditingId(null); setNewProvider({ id: '', name: '', baseURL: '', apiKey: '', models: [], enabled: true }); }} className="flex-1">
                {t('common.cancel') || 'Cancel'}
              </Button>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
};
