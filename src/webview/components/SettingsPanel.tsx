import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import type { AgentMode, ProviderConfig } from '@shared/index';
import { postMessage as postToHost } from '../vscodeApi';
import { GeneralSection } from './settings/GeneralSection';
import { ModesSection } from './settings/ModesSection';
import { ModelsSection } from './settings/ModelsSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { PermissionsSection } from './settings/PermissionsSection';
import { McpSection } from './settings/McpSection';
import { SkillsSection } from './settings/SkillsSection';
import { AdvancedSection } from './settings/AdvancedSection';

type SettingsTab = 'general' | 'modes' | 'models' | 'providers' | 'permissions' | 'mcp' | 'skills' | 'advanced';

export const SettingsPanel: React.FC = () => {
  const t = useStore((s) => s.t);
  const config = useStore((s) => s.config);
  const servers = useStore((s) => s.mcpServers);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Local state for providers (draft until saved)
  const [providers, setProviders] = useState<ProviderConfig[]>(config?.providers ?? []);

  // Local state for model assignments
  const [modelAssignments, setModelAssignments] = useState<Record<AgentMode, string>>(
    config?.modelAssignments ?? ({} as Record<AgentMode, string>)
  );

  // FIX (stale drafts): re-sync the drafts when a REAL config change arrives.
  // The host pushes CONFIG constantly (echoes, busy toggles, mid-run mode
  // switches) with brand-new object references each time — syncing on every
  // push WIPED in-progress edits. We now compare serialized snapshots: a push
  // is only applied when the incoming data actually differs from the last
  // data we applied (echo pushes and unrelated updates keep the drafts).
  const appliedRef = useRef<string | null>(null);
  useEffect(() => {
    const incoming = JSON.stringify([config?.providers ?? [], config?.modelAssignments ?? {}]);
    if (appliedRef.current === null) {
      // First render: adopt the host state as the baseline (drafts were
      // already initialized from useState with the same values).
      appliedRef.current = incoming;
      return;
    }
    if (incoming === appliedRef.current) return;
    appliedRef.current = incoming;
    setProviders(config?.providers ?? []);
    setModelAssignments(config?.modelAssignments ?? ({} as Record<AgentMode, string>));
  }, [config?.providers, config?.modelAssignments]);

  // FIX (write-only UI): provider/model-assignment edits are now persisted
  // immediately (same behavior as every other settings section) — previously
  // they only lived in local state and were LOST when the panel closed.
  const handleProvidersChange = (next: ProviderConfig[]) => {
    setProviders(next);
    postToHost({ type: 'SET_PROVIDERS', providers: next });
  };
  const handleAssignmentsChange = (next: Record<AgentMode, string>) => {
    setModelAssignments(next);
    postToHost({ type: 'SET_MODEL_ASSIGNMENTS', assignments: next });
  };

  if (!config) return null;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: t('tabs.general'), icon: <GeneralIcon /> },
    { id: 'modes', label: t('tabs.modes'), icon: <ModesIcon /> },
    { id: 'models', label: t('tabs.models'), icon: <ModelsIcon /> },
    { id: 'providers', label: t('tabs.providers'), icon: <ProvidersIcon /> },
    { id: 'permissions', label: t('tabs.permissions') || 'Permissions', icon: <PermissionsIcon /> },
    { id: 'mcp', label: t('tabs.mcp'), icon: <McpIcon /> },
    { id: 'skills', label: t('tabs.skills'), icon: <SkillsIcon /> },
    { id: 'advanced', label: t('tabs.advanced') || 'Advanced', icon: <AdvancedIcon /> },
  ];

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar — VS Code-style vertical nav. Collapses to an icon-only rail
          on narrow panels (<480px ≈ the whole webview viewport, since a VS Code
          webview's viewport equals the panel width, plain breakpoints work). */}
      <div className="w-12 min-[480px]:w-36 shrink-0 bg-panel border-l border-border-subtle flex flex-col min-h-0">
        <div className="p-3 border-b border-border-subtle flex items-center justify-center min-[480px]:justify-center">
          <h2 className="section-label hidden min-[480px]:block">{t('settings.title')}</h2>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`w-full flex items-center justify-center min-[480px]:justify-start gap-2 px-2.5 py-2 rounded-button text-xs transition-all duration-fast ${
                activeTab === tab.id
                  ? 'bg-brand/10 text-brand font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0">{tab.icon}</span>
              <span className="hidden min-[480px]:inline truncate">{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 min-[480px]:p-4 lg:p-6">
        <div className="max-w-2xl mx-auto">
          {activeTab === 'general' && <GeneralSection config={config} t={t} />}
          {activeTab === 'modes' && <ModesSection config={config} t={t} />}
          {activeTab === 'models' && (
            <ModelsSection
              config={config}
              modelAssignments={modelAssignments}
              onAssignmentsChange={handleAssignmentsChange}
              t={t}
            />
          )}
          {activeTab === 'providers' && (
            <ProvidersSection
              config={config}
              providers={providers}
              onProvidersChange={handleProvidersChange}
              t={t}
            />
          )}
          {activeTab === 'permissions' && <PermissionsSection config={config} t={t} />}
          {activeTab === 'mcp' && <McpSection config={config} servers={servers} t={t} />}
          {activeTab === 'skills' && <SkillsSection config={config} t={t} />}
          {activeTab === 'advanced' && <AdvancedSection config={config} t={t} />}
        </div>
      </div>
    </div>
  );
};

/* ── Sidebar Icons ──
   Unified VS Code codicon-inspired STROKE set: 16×16 grid, stroke=currentColor,
   strokeWidth 1.3, round joins/caps, so every icon shares the same visual weight. */

const RailIcon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Gear — general */
const GeneralIcon: React.FC = () => (
  <RailIcon>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.6v2M8 12.4v2M14.4 8h-2M3.6 8h-2M12.62 3.38l-1.41 1.41M4.79 11.21l-1.41 1.41M12.62 12.62l-1.41-1.41M4.79 4.79L3.38 3.38" />
  </RailIcon>
);

/** Puzzle piece — custom modes */
const ModesIcon: React.FC = () => (
  <RailIcon>
    <path d="M6.4 2.2h3.2v1.5a1.1 1.1 0 1 0 2.2 0V2.2h1.5a1 1 0 0 1 1 1v3.2h-1.5a1.1 1.1 0 1 0 0 2.2h1.5v3.2a1 1 0 0 1-1 1h-3.2v-1.5a1.1 1.1 0 1 0-2.2 0v1.5H4.7a1 1 0 0 1-1-1V9.3h1.5a1.1 1.1 0 1 0 0-2.2H3.7V4.2a1 1 0 0 1 1-1h1.7v-1z" />
  </RailIcon>
);

/** Chip / layers — models */
const ModelsIcon: React.FC = () => (
  <RailIcon>
    <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" />
    <path d="M6.3 6.3h3.4v3.4H6.3z" />
    <path d="M5.7 1.7v2.5M10.3 1.7v2.5M5.7 11.8v2.5M10.3 11.8v2.5M1.7 5.7h2.5M1.7 10.3h2.5M11.8 5.7h2.5M11.8 10.3h2.5" />
  </RailIcon>
);

/** Cloud plug — providers */
const ProvidersIcon: React.FC = () => (
  <RailIcon>
    <path d="M12 6.67h-.84A5.33 5.33 0 1 0 6 13.33h6a3.33 3.33 0 0 0 0-6.67z" />
    <path d="M8 9.2v2.3M6.9 10.35h2.2" />
  </RailIcon>
);

/** Shield-check — permissions */
const PermissionsIcon: React.FC = () => (
  <RailIcon>
    <path d="M8 1.6l5.2 1.9v3.3c0 3.35-2.2 6.25-5.2 7.55-3-1.3-5.2-4.2-5.2-7.55V3.5L8 1.6z" />
    <path d="M5.9 7.95l1.45 1.45 2.75-2.75" />
  </RailIcon>
);

/** Plug — MCP */
const McpIcon: React.FC = () => (
  <RailIcon>
    <path d="M6 1.6v3.7M10 1.6v3.7" />
    <path d="M3.9 5.3h8.2v3a3 3 0 0 1-3 3h-2.2a3 3 0 0 1-3-3v-3z" />
    <path d="M8 11.3v3.1" />
  </RailIcon>
);

/** Sparkles — skills */
const SkillsIcon: React.FC = () => (
  <RailIcon>
    <path d="M9.8 1.9l1.05 2.5 2.5 1.05-2.5 1.05L9.8 9l-1.05-2.5-2.5-1.05 2.5-1.05L9.8 1.9z" />
    <path d="M4.4 8.8l.72 1.73 1.73.71-1.73.72-.72 1.73-.72-1.73-1.72-.72 1.72-.71.72-1.73z" />
  </RailIcon>
);

/** Beaker — advanced */
const AdvancedIcon: React.FC = () => (
  <RailIcon>
    <path d="M6 1.8h4" />
    <path d="M6.8 6.2L3.75 11.6a1.75 1.75 0 0 0 1.53 2.6h5.44a1.75 1.75 0 0 0 1.53-2.6L9.2 6.2" />
    <path d="M6.8 1.8v4.4M9.2 1.8v4.4" />
    <path d="M5.15 10.9h5.7" />
  </RailIcon>
);
