import React, { useEffect, useRef, useState } from 'react';
import type { AgentConfig, McpServerConfig } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { useStore } from '../../store/useStore';
import { fill } from '../../lib/format';
import { MCP_PRESETS, presetCommandLine, type McpPreset } from '../../lib/mcpPresets';
import { CollapsibleSection, Section, SettingRow, Toggle, Button, EmptyState } from './ui';

/* ── JSON parsing helpers (liberal: accepts every common client shape) ── */

const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === 'string');

/** "https://21st.dev/api/mcp" → "21st-dev" (hostname, dots → dashes). */
const hostLabel = (url: string): string => {
  try {
    const host = new URL(url).hostname.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    return host || 'server';
  } catch {
    return 'server';
  }
};

/**
 * Build an McpServerConfig from a liberal JSON entry. `transport` is inferred
 * from the presence of `url`; no manual name/command fields are needed here.
 * Returns null when the entry has neither url nor command (ignored silently).
 */
const buildServer = (
  cfg: Record<string, unknown>,
  nameHint: string | undefined,
  takeName: (base: string) => string
): McpServerConfig | null => {
  const url = typeof cfg.url === 'string' && cfg.url.trim() ? cfg.url.trim() : undefined;
  const command = typeof cfg.command === 'string' && cfg.command.trim() ? cfg.command.trim() : undefined;
  if (!url && !command) return null;

  const headers = isStringRecord(cfg.headers) ? cfg.headers : undefined;
  const args = Array.isArray(cfg.args)
    ? cfg.args.filter((a): a is string => typeof a === 'string')
    : undefined;
  const env = isStringRecord(cfg.env) ? cfg.env : undefined;

  const hinted = nameHint ?? (typeof cfg.name === 'string' ? cfg.name : '');
  const base =
    hinted.trim() ||
    (url ? hostLabel(url) : (command ?? 'server').split(/[\\/]/).pop() || 'server');

  return {
    name: takeName(base),
    transport: url ? 'http' : 'stdio',
    enabled: true,
    ...(url ? { url } : {}),
    ...(headers ? { headers } : {}),
    ...(command ? { command } : {}),
    ...(args && args.length ? { args } : {}),
    ...(env && Object.keys(env).length ? { env } : {}),
  };
};

type ParseResult =
  | { ok: true; servers: McpServerConfig[] }
  | { ok: false; reason: 'invalid' | 'none' };

/**
 * Accepts, in order:
 *  1. client format `{ mcpServers: { Name: { url|command, … } } }`
 *  2. single server object `{ url, headers }` / `{ name, command, … }`
 *  3. bare map `{ Name: { … }, Name2: { … } }`
 *  4. array `[ { name?, url… } | { name, command } ]`
 */
const parseJsonConfig = (raw: string, existing: Set<string>): ParseResult => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'invalid' };

  const entries: Array<{ name?: string; cfg: Record<string, unknown> }> = [];
  const collectMap = (obj: Record<string, unknown>) => {
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        entries.push({ name: key, cfg: val as Record<string, unknown> });
      }
    }
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        entries.push({ cfg: item as Record<string, unknown> });
      }
    }
  } else {
    const obj = data as Record<string, unknown>;
    const mcpServers = obj.mcpServers;
    if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
      collectMap(mcpServers as Record<string, unknown>);
    } else if ('url' in obj || 'command' in obj) {
      entries.push({ name: typeof obj.name === 'string' ? obj.name : undefined, cfg: obj });
    } else {
      const vals = Object.values(obj);
      if (vals.length === 0) return { ok: false, reason: 'none' };
      if (vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
        collectMap(obj); // bare name → config map
      } else {
        return { ok: false, reason: 'invalid' };
      }
    }
  }

  if (entries.length === 0) return { ok: false, reason: 'none' };

  // Names are made unique against existing servers AND within this batch.
  const taken = new Set(existing);
  const takeName = (base: string): string => {
    let clean = base.trim().slice(0, 40) || 'server';
    if (!taken.has(clean)) {
      taken.add(clean);
      return clean;
    }
    let i = 2;
    while (taken.has(`${clean}-${i}`)) i++;
    const name = `${clean}-${i}`;
    taken.add(name);
    return name;
  };

  const servers: McpServerConfig[] = [];
  for (const e of entries) {
    const built = buildServer(e.cfg, e.name, takeName);
    if (built) servers.push(built);
  }
  return servers.length ? { ok: true, servers } : { ok: false, reason: 'none' };
};

/* ── Section ── */

export const McpSection: React.FC<{
  config: AgentConfig;
  servers: McpServerConfig[];
  t: (k: string) => string;
}> = ({ config, servers, t }) => {
  const setNotice = useStore((s) => s.setNotice);
  // Add-via-JSON card state
  const [jsonText, setJsonText] = useState('');
  const [untouched, setUntouched] = useState(true); // shows the i18n example until edited
  const [errorKind, setErrorKind] = useState<'invalid' | 'none' | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  // Marketplace region — collapsed by default.
  const [marketOpen, setMarketOpen] = useState(false);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  }, []);

  // While empty & untouched the textarea displays the ready example ONCE.
  const example = t('mcp.json.placeholder');
  const value = untouched && jsonText === '' ? example : jsonText;

  const handleChange = (v: string) => {
    setJsonText(v);
    setUntouched(false);
    setErrorKind(null);
  };

  const insertExample = () => {
    setJsonText(example);
    setUntouched(false);
    setErrorKind(null);
  };

  const doImport = () => {
    setErrorKind(null);
    if (successTimer.current) clearTimeout(successTimer.current);

    const existing = new Set(servers.map((s) => s.name));
    const res = parseJsonConfig(value, existing);
    if (!res.ok) {
      setErrorKind(res.reason);
      return;
    }

    for (const server of res.servers) {
      postToHost({ type: 'ADD_MCP_SERVER', server });
    }
    postToHost({ type: 'LIST_MCP_SERVERS' });

    setJsonText('');
    setUntouched(true);
    setImportedCount(res.servers.length);
    successTimer.current = setTimeout(() => setImportedCount(null), 2500);
  };

  const headerCount = (s: McpServerConfig): number =>
    s.headers ? Object.keys(s.headers).length : 0;

  /* ── Marketplace: one-click preset add (same flow as the JSON importer) ── */

  const addedNames = new Set(servers.map((s) => s.name.toLowerCase()));

  const addPreset = (preset: McpPreset) => {
    const server: McpServerConfig = {
      name: preset.name,
      transport: 'stdio',
      enabled: true,
      command: preset.command,
      args: preset.args,
      // Token envs are added with EMPTY values on purpose — the user fills
      // them in afterwards (re-add via the JSON importer with the real token).
      ...(preset.env && Object.keys(preset.env).length ? { env: { ...preset.env } } : {}),
    };
    // Same ADD_MCP_SERVER → LIST_MCP_SERVERS refresh flow as doImport();
    // the host's MCP_SERVERS push updates the store list.
    postToHost({ type: 'ADD_MCP_SERVER', server });
    postToHost({ type: 'LIST_MCP_SERVERS' });
    setNotice(fill(t('mcpMarket.addedNote'), { name: preset.name }));
  };

  const marketTitle = `${t('mcpMarket.title')} · ${fill(t('mcpMarket.items'), { n: MCP_PRESETS.length })}`;

  return (
    <div className="space-y-6">
      {/* MCP integration toggle (unchanged) */}
      <Section title={t('mcp.title')}>
        <SettingRow label={t('settings.enableMCP')}>
          <Toggle checked={config.enableMCP} onChange={(v) => postToHost({ type: 'SET_CONFIG', key: 'enableMCP', value: v })} />
        </SettingRow>
        {!config.enableMCP && (
          <div className="text-xs text-status-warning bg-status-warning/10 rounded-card p-2.5 border border-status-warning/20">
            {t('mcp.disabled')}
          </div>
        )}

        {/* Marketplace — one-click presets, above the server list (collapsed by default) */}
        <CollapsibleSection
          title={marketTitle}
          expanded={marketOpen}
          onToggle={() => setMarketOpen((v) => !v)}
        >
          <div className="space-y-2">
            <p className="text-2xs text-text-muted leading-relaxed">{t('mcpMarket.hint')}</p>
            <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-2">
              {MCP_PRESETS.map((preset) => {
                const added =
                  addedNames.has(preset.name.toLowerCase()) ||
                  addedNames.has(preset.id.toLowerCase());
                const label = added ? t('mcpMarket.added') : t('mcpMarket.add');
                return (
                  <div
                    key={preset.id}
                    className={`flex items-start gap-2 rounded-card border p-2 transition-colors duration-fast ${
                      added
                        ? 'border-status-success/30 bg-status-success/5'
                        : 'bg-input border-border-subtle'
                    }`}
                  >
                    <span className="text-base leading-none shrink-0" aria-hidden="true">{preset.emoji}</span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-xs font-medium text-text-primary truncate">{preset.name}</div>
                      <p className="text-2xs text-text-muted leading-relaxed">
                        {t(`mcpMarket.items.${preset.id}.desc`)}
                      </p>
                      <div
                        className="font-mono text-2xs text-text-tertiary truncate"
                        dir="ltr"
                        title={presetCommandLine(preset)}
                      >
                        {presetCommandLine(preset)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addPreset(preset)}
                      disabled={added}
                      title={added ? label : `${label}: ${preset.name}`}
                      aria-label={added ? label : `${label}: ${preset.name}`}
                      className={`relative shrink-0 inline-flex items-center gap-1 text-2xs px-2 py-1.5 rounded-button border transition-colors duration-fast after:content-[''] after:absolute after:-inset-2.5 ${
                        added
                          ? 'text-status-success border-status-success/30 bg-status-success/10 cursor-default'
                          : 'text-brand border-border-input bg-elevated-2 hover:bg-hover hover:border-brand/40'
                      }`}
                    >
                      {added ? (
                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      )}
                      <span>{label}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </CollapsibleSection>

        {servers.length === 0 ? (
          <EmptyState message={t('mcp.empty')} />
        ) : (
          <div className="space-y-2">
            {servers.map((s) => {
              const isHttp = s.transport === 'http' || (!s.command && !!s.url);
              const hCount = headerCount(s);
              return (
                <div key={s.name} className="border border-border-subtle rounded-card bg-input overflow-hidden hover:border-border-input transition-colors duration-fast">
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-elevated-2/40">
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-3.5 h-3.5 text-brand shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 1.6v3.7M10 1.6v3.7" />
                        <path d="M3.9 5.3h8.2v3a3 3 0 0 1-3 3h-2.2a3 3 0 0 1-3-3v-3z" />
                        <path d="M8 11.3v3.1" />
                      </svg>
                      <span className="font-medium text-sm truncate">{s.name}</span>
                      <span
                        className={`text-2xs px-1.5 py-px rounded border shrink-0 ${
                          isHttp
                            ? 'text-status-info border-status-info/30 bg-status-info/10'
                            : 'text-text-tertiary border-border-subtle bg-elevated-2'
                        }`}
                      >
                        {isHttp ? t('mcp.transport.http') : t('mcp.transport.stdio')}
                      </span>
                      {hCount > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 text-2xs text-text-muted bg-elevated-2 border border-border-subtle rounded px-1 py-px shrink-0"
                          title={t('mcp.headers')}
                        >
                          <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="3.5" y="7" width="9" height="6" rx="1" />
                            <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
                          </svg>
                          {hCount}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${s.enabled === false ? 'bg-status-error' : 'bg-status-success'}`} />
                      <Button onClick={() => postToHost({ type: 'TEST_MCP_SERVER', name: s.name })}>{t('mcp.test')}</Button>
                      <Button variant="danger" onClick={() => postToHost({ type: 'REMOVE_MCP_SERVER', name: s.name })}>{t('mcp.remove')}</Button>
                    </div>
                  </div>
                  {isHttp ? (
                    <div className="px-3 py-2 border-t border-border-subtle" dir="ltr">
                      <div className="font-mono text-2xs text-text-tertiary truncate" title={s.url}>
                        {s.url}
                      </div>
                    </div>
                  ) : (
                    <div className="px-3 py-2 border-t border-border-subtle" dir="ltr">
                      <div className="font-mono text-2xs text-text-tertiary truncate" title={`${s.command ?? ''} ${(s.args ?? []).join(' ')}`}>
                        {[s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Add via JSON — no manual name/command/args/env fields anymore */}
      <Section title={t('mcp.json.title')}>
        <div className="space-y-2">
          <p className="text-2xs text-text-muted leading-relaxed">{t('mcp.json.desc')}</p>
          <textarea
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            rows={10}
            dir="ltr"
            spellCheck={false}
            className="w-full bg-panel text-text-primary rounded-card px-2.5 py-2 text-xs outline-none border border-border-input focus:border-border-focus transition-colors duration-fast font-mono resize-y leading-relaxed"
          />
          {errorKind === 'invalid' && (
            <div className="text-2xs text-status-error">{t('mcp.json.invalid')}</div>
          )}
          {errorKind === 'none' && (
            <div className="text-2xs text-status-error">{t('mcp.json.noServer')}</div>
          )}
          <div className="flex flex-col min-[480px]:flex-row gap-1.5">
            <Button onClick={insertExample} className="min-[480px]:shrink-0">{t('mcp.json.example')}</Button>
            <div className="grow" />
            <Button variant="primary" onClick={doImport} className="min-[480px]:shrink-0">{t('mcp.json.import')}</Button>
          </div>
          {importedCount !== null && (
            <div className="text-2xs text-status-success">
              ✓ {importedCount} × {t('mcp.add')}
            </div>
          )}
          <div className="text-2xs text-text-secondary bg-status-info/10 border border-status-info/20 rounded-card p-2.5 leading-relaxed">
            {t('mcp.json.help')}
          </div>
        </div>
      </Section>
    </div>
  );
};
