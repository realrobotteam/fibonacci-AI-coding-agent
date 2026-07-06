import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import type { McpServerConfig } from '@shared/index';
import { postMessage as postToHost } from '../vscodeApi';

export const SettingsPanel: React.FC = () => {
  const t = useStore((s) => s.t);
  const config = useStore((s) => s.config);
  const servers = useStore((s) => s.mcpServers);
  const draftApiKey = useStore((s) => s.draftApiKey);
  const setDraftApiKey = useStore((s) => s.setDraftApiKey);
  const [showSaved, setShowSaved] = useState(false);
  const [mcpExpanded, setMcpExpanded] = useState(true);

  if (!config) return null;

  const saveApiKey = () => {
    if (!draftApiKey.trim()) return;
    postToHost({ type: 'SAVE_API_KEY', apiKey: draftApiKey.trim() });
    setDraftApiKey('');
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-3 space-y-5 text-text-primary max-w-[400px] mx-auto">
        {/* Section: API */}
        <section className="space-y-2">
          <h2 className="section-label">{t('settings.title')}</h2>
          <div className="space-y-1.5">
            <label className="block text-xs text-text-secondary font-medium">{t('settings.apiKey')}</label>
            <div className="flex gap-1.5">
              <input
                type="password"
                value={draftApiKey}
                onChange={(e) => setDraftApiKey(e.target.value)}
                placeholder="fib-..."
                dir="ltr"
                className="flex-1 bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast"
              />
              <button
                onClick={saveApiKey}
                disabled={!draftApiKey.trim()}
                className="bg-brand hover:bg-brand-hover text-white text-xs px-3 py-1.5 rounded-card disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-fast"
              >
                {t('settings.save')}
              </button>
            </div>
            <div className="text-[11px]">
              {config.apiKeySet ? (
                <span className="text-status-success inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-status-success rounded-full" />
                  {t('settings.apiKey.set')}
                </span>
              ) : (
                <span className="text-status-warning">{t('settings.apiKey.unset')}</span>
              )}
              {showSaved && <span className="text-status-success mr-2">✓</span>}
            </div>
          </div>
        </section>

        {/* Section: API config (read-only) */}
        <section className="space-y-2">
          <label className="block text-xs text-text-secondary font-medium">{t('settings.baseURL')}</label>
          <input
            type="text"
            value={config.baseURL}
            readOnly
            dir="ltr"
            className="w-full bg-input text-text-tertiary rounded-card px-2.5 py-1.5 text-xs border border-border-subtle"
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-text-secondary font-medium mb-1">{t('settings.model')}</label>
              <input
                type="text"
                value={config.defaultModel}
                readOnly
                dir="ltr"
                className="w-full bg-input text-text-tertiary rounded-card px-2.5 py-1.5 text-xs border border-border-subtle"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary font-medium mb-1">{t('settings.language')}</label>
              <input
                type="text"
                value={config.language === 'fa' ? 'فارسی (fa)' : 'English (en)'}
                readOnly
                className="w-full bg-input text-text-tertiary rounded-card px-2.5 py-1.5 text-xs border border-border-subtle"
              />
            </div>
          </div>
        </section>

        {/* Section: Behavior toggles */}
        <section className="space-y-2">
          <h2 className="section-label">{t('settings.behavior')}</h2>
          <ToggleRow label={t('settings.enableMCP')} value={config.enableMCP} />
          <ToggleRow label={t('settings.autoApproveReadOnly')} value={config.autoApproveReadOnly} />
          <div className="flex items-center justify-between text-xs px-2.5 py-2 bg-input rounded-card border border-border-subtle">
            <span className="text-text-secondary">{t('settings.maxIterations')}</span>
            <span className="text-text-primary font-medium">{config.maxIterations}</span>
          </div>
        </section>

        {/* Section: MCP servers (moved here from the removed MCP tab) */}
        <section className="space-y-2">
          <button
            onClick={() => setMcpExpanded((v) => !v)}
            className="w-full flex items-center justify-between section-label hover:text-text-secondary transition-colors duration-fast"
          >
            <span>{t('mcp.title')}</span>
            <svg className={`w-3 h-3 transition-transform ${mcpExpanded ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="currentColor">
              <path d="M5 3l6 5-6 5V3z" />
            </svg>
          </button>
          {mcpExpanded && <McpSection servers={servers} />}
        </section>

        {/* Section: open in VS Code settings */}
        <button
          onClick={() => postToHost({ type: 'OPEN_SETTINGS' })}
          className="w-full bg-input hover:bg-hover text-text-primary text-xs py-2 rounded-card border border-border-input hover:border-border-focus transition-colors duration-fast"
        >
          {t('settings.openVSCode')}
        </button>
      </div>
    </div>
  );
};

const ToggleRow: React.FC<{ label: string; value: boolean }> = ({ label, value }) => (
  <div className="flex items-center justify-between text-xs px-2.5 py-2 bg-input rounded-card border border-border-subtle">
    <span className="text-text-secondary">{label}</span>
    <span
      className={`relative w-8 h-4 rounded-full transition-colors duration-fast ${
        value ? 'bg-brand' : 'bg-elevated-2'
      }`}
    >
      <span
        className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform duration-fast ${
          value ? 'right-0.5' : 'right-4'
        }`}
      />
    </span>
  </div>
);

const McpSection: React.FC<{ servers: McpServerConfig[] }> = ({ servers }) => {
  const t = useStore((s) => s.t);
  const [newServer, setNewServer] = useState<McpServerConfig>({
    name: '',
    command: '',
    args: [],
  });
  const [argsText, setArgsText] = useState('');

  const add = () => {
    if (!newServer.name || !newServer.command) return;
    const args = argsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    postToHost({
      type: 'ADD_MCP_SERVER',
      server: { ...newServer, args },
    });
    setNewServer({ name: '', command: '', args: [] });
    setArgsText('');
  };

  return (
    <div className="space-y-2">
      {servers.length === 0 && (
        <div className="text-xs text-text-tertiary bg-input rounded-card p-3 border border-border-subtle">
          {t('mcp.empty')}
        </div>
      )}

      {servers.map((s) => (
        <div
          key={s.name}
          className="border border-border-subtle rounded-card bg-input overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 py-2 bg-elevated-2/40">
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M10 2v3H6V2H4v3h-.5A1.5 1.5 0 0 0 2 6.5v2A1.5 1.5 0 0 0 3.5 10H4v3h2v-3h4v3h2v-3h.5A1.5 1.5 0 0 1 14 8.5v-2A1.5 1.5 0 0 0 12.5 5H12V2h-2z" />
              </svg>
              <span className="font-medium text-sm truncate">{s.name}</span>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={() => postToHost({ type: 'TEST_MCP_SERVER', name: s.name })}
                className="bg-elevated-2 hover:bg-hover text-text-secondary hover:text-text-primary text-[11px] px-2 py-1 rounded-button border border-border-input transition-colors duration-fast"
              >
                {t('mcp.test')}
              </button>
              <button
                onClick={() => postToHost({ type: 'REMOVE_MCP_SERVER', name: s.name })}
                className="bg-elevated-2 hover:bg-status-error/30 text-text-secondary hover:text-status-error text-[11px] px-2 py-1 rounded-button border border-border-input hover:border-status-error/40 transition-colors duration-fast"
              >
                {t('mcp.remove')}
              </button>
            </div>
          </div>
          <pre
            className="text-[10px] text-text-tertiary px-3 py-2 bg-panel overflow-x-auto"
            dir="ltr"
          >
            {s.command} {(s.args ?? []).join(' ')}
          </pre>
        </div>
      ))}

      {/* Add new server form */}
      <div className="border-t border-border-subtle pt-3 space-y-2">
        <div className="section-label">{t('mcp.add')}</div>
        <input
          type="text"
          value={newServer.name}
          onChange={(e) => setNewServer({ ...newServer, name: e.target.value })}
          placeholder={t('mcp.name')}
          dir="ltr"
          className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast"
        />
        <input
          type="text"
          value={newServer.command}
          onChange={(e) => setNewServer({ ...newServer, command: e.target.value })}
          placeholder={t('mcp.command')}
          dir="ltr"
          className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast"
        />
        <input
          type="text"
          value={argsText}
          onChange={(e) => setArgsText(e.target.value)}
          placeholder={t('mcp.args')}
          dir="ltr"
          className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast"
        />
        <button
          onClick={add}
          disabled={!newServer.name || !newServer.command}
          className="w-full bg-brand hover:bg-brand-hover text-white text-xs py-1.5 rounded-card disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-fast"
        >
          {t('mcp.add')}
        </button>
      </div>
    </div>
  );
};
