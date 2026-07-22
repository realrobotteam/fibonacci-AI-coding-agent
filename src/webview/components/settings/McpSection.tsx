import React, { useState } from 'react';
import type { AgentConfig, McpServerConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { Section, TextInput, Button, EmptyState, CollapsibleSection } from './ui';

export const McpSection: React.FC<{
  config: AgentConfig;
  servers: McpServerConfig[];
  t: (k: string) => string;
}> = ({ config, servers, t }) => {
  const [newServer, setNewServer] = useState<McpServerConfig>({ name: '', command: '', args: [], env: {} });
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  const add = () => {
    if (!newServer.name || !newServer.command) return;
    const args = argsText.split(',').map((s) => s.trim()).filter(Boolean);
    const env = parseEnv(envText);
    postToHost({ type: 'ADD_MCP_SERVER', server: { ...newServer, args, env } });
    setNewServer({ name: '', command: '', args: [], env: {} });
    setArgsText('');
    setEnvText('');
  };

  const toggleServer = (name: string) => {
    const server = servers.find((s) => s.name === name);
    if (!server) return;
    postToHost({ type: 'ADD_MCP_SERVER', server: { ...server, enabled: server.enabled === false ? true : false } });
    postToHost({ type: 'REMOVE_MCP_SERVER', name });
  };

  const parseEnv = (text: string): Record<string, string> => {
    if (!text.trim()) return {};
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key && rest.length > 0) {
        env[key.trim()] = rest.join('=').trim();
      }
    }
    return env;
  };

  const formatEnv = (env?: Record<string, string>): string => {
    if (!env || Object.keys(env).length === 0) return '';
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  };

  return (
    <div className="space-y-6">
      {/* MCP integration toggle */}
      <Section title={t('mcp.title')}>
        {!config.enableMCP && (
          <div className="text-xs text-status-warning bg-status-warning/10 rounded-card p-2.5 border border-status-warning/20">
            {t('mcp.disabled')}
          </div>
        )}
        {servers.length === 0 ? (
          <EmptyState message={t('mcp.empty')} />
        ) : (
          <div className="space-y-2">
            {servers.map((s) => (
              <div key={s.name} className="border border-border-subtle rounded-card bg-input overflow-hidden hover:border-border-input transition-colors duration-fast">
                <div className="flex items-center justify-between px-3 py-2.5 bg-elevated-2/40">
                  <div className="flex items-center gap-2 min-w-0">
                    <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M10 2v3H6V2H4v3h-.5A1.5 1.5 0 0 0 2 6.5v2A1.5 1.5 0 0 0 3.5 10H4v3h2v-3h4v3h2v-3h.5A1.5 1.5 0 0 1 14 8.5v-2A1.5 1.5 0 0 0 12.5 5H12V2h-2z" />
                    </svg>
                    <span className="font-medium text-sm truncate">{s.name}</span>
                    <span className={`w-2 h-2 rounded-full ${s.enabled === false ? 'bg-status-error' : 'bg-status-success'}`} />
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button onClick={() => postToHost({ type: 'TEST_MCP_SERVER', name: s.name })}>{t('mcp.test')}</Button>
                    <Button onClick={() => setExpandedServer(expandedServer === s.name ? null : s.name)}>
                      {expandedServer === s.name ? t('common.collapse') : t('common.expand')}
                    </Button>
                    <Button variant="danger" onClick={() => postToHost({ type: 'REMOVE_MCP_SERVER', name: s.name })}>{t('mcp.remove')}</Button>
                  </div>
                </div>
                <pre className="text-2xs text-text-tertiary px-3 py-2 bg-panel overflow-x-auto" dir="ltr">
                  {s.command} {(s.args ?? []).join(' ')}
                </pre>
                {expandedServer === s.name && s.env && Object.keys(s.env).length > 0 && (
                  <div className="px-3 py-2 border-t border-border-subtle">
                    <div className="text-2xs text-text-muted mb-1">{t('mcp.env') || 'Environment'}:</div>
                    <pre className="text-2xs text-text-tertiary bg-panel rounded px-2 py-1" dir="ltr">
                      {formatEnv(s.env)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Add server form */}
      <Section title={t('mcp.add')}>
        <div className="space-y-2">
          <TextInput
            value={newServer.name}
            onChange={(v) => setNewServer({ ...newServer, name: v })}
            placeholder={t('mcp.name')}
          />
          <TextInput
            value={newServer.command}
            onChange={(v) => setNewServer({ ...newServer, command: v })}
            placeholder={t('mcp.command')}
          />
          <TextInput
            value={argsText}
            onChange={setArgsText}
            placeholder={t('mcp.args')}
          />
          <div>
            <label className="text-2xs text-text-muted block mb-1">{t('mcp.env') || 'Environment Variables'}:</label>
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'KEY=value\nANOTHER_KEY=value2'}
              rows={3}
              dir="ltr"
              className="w-full bg-input text-text-primary rounded-card px-2.5 py-1.5 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast font-mono resize-none"
            />
          </div>
          <Button variant="primary" onClick={add} disabled={!newServer.name || !newServer.command} className="w-full">
            {t('mcp.add')}
          </Button>
        </div>
      </Section>
    </div>
  );
};
