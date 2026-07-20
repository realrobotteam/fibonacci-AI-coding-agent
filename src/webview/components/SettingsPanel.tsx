import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import type { AgentMode, ProviderConfig } from '@shared/index';
import { GeneralSection } from './settings/GeneralSection';
import { ModelsSection } from './settings/ModelsSection';
import { ProvidersSection } from './settings/ProvidersSection';
import { PermissionsSection } from './settings/PermissionsSection';
import { McpSection } from './settings/McpSection';
import { SkillsSection } from './settings/SkillsSection';
import { AdvancedSection } from './settings/AdvancedSection';

type SettingsTab = 'general' | 'models' | 'providers' | 'permissions' | 'mcp' | 'skills' | 'advanced';

export const SettingsPanel: React.FC = () => {
  const t = useStore((s) => s.t);
  const config = useStore((s) => s.config);
  const servers = useStore((s) => s.mcpServers);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Local state for providers (draft until saved)
  const [providers, setProviders] = useState<ProviderConfig[]>(config?.providers ?? []);

  // Local state for model assignments
  const [modelAssignments, setModelAssignments] = useState<Record<AgentMode, string>>(
    config?.modelAssignments ?? {}
  );

  if (!config) return null;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: t('tabs.general'), icon: <GeneralIcon /> },
    { id: 'models', label: t('tabs.models'), icon: <ModelsIcon /> },
    { id: 'providers', label: t('tabs.providers'), icon: <ProvidersIcon /> },
    { id: 'permissions', label: t('tabs.permissions') || 'Permissions', icon: <PermissionsIcon /> },
    { id: 'mcp', label: t('tabs.mcp'), icon: <McpIcon /> },
    { id: 'skills', label: t('tabs.skills'), icon: <SkillsIcon /> },
    { id: 'advanced', label: t('tabs.advanced') || 'Advanced', icon: <AdvancedIcon /> },
  ];

  return (
    <div className="flex-1 flex min-h-0">
      {/* Sidebar */}
      <div className="w-36 bg-panel border-l border-border-subtle flex flex-col min-h-0">
        <div className="p-3 border-b border-border-subtle">
          <h2 className="section-label text-center">{t('settings.title')}</h2>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-button text-xs transition-all duration-fast ${
                activeTab === tab.id
                  ? 'bg-brand/10 text-brand font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-hover'
              }`}
            >
              <span className="w-5 h-5 flex items-center justify-center">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="max-w-2xl mx-auto">
          {activeTab === 'general' && <GeneralSection config={config} t={t} />}
          {activeTab === 'models' && (
            <ModelsSection
              config={config}
              modelAssignments={modelAssignments}
              onAssignmentsChange={setModelAssignments}
              t={t}
            />
          )}
          {activeTab === 'providers' && (
            <ProvidersSection
              config={config}
              providers={providers}
              onProvidersChange={setProviders}
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

/* ── Sidebar Icons ── */

const GeneralIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.4h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.4-.5V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.8-.3zM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" /></svg>
);

const ModelsIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M2 2h12v12H2V2zm1 1v10h10V3H3zm4.5 2a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zm0 3a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1h-3zm0 3a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5z" /></svg>
);

const ProvidersIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M1.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-13zm13-1H1.5a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 14.5 1zM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></svg>
);

const PermissionsIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M8 1a2 2 0 0 0-2 2v1H4.5A1.5 1.5 0 0 0 3 5.5v8A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 11.5 4H10V3a2 2 0 0 0-2-2zm0 1.5a.5.5 0 0 1 .5.5v1h-1V3a.5.5 0 0 1 .5-.5zM6 7.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5z" /></svg>
);

const McpIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M10 2v3H6V2H4v3h-.5A1.5 1.5 0 0 0 2 6.5v2A1.5 1.5 0 0 0 3.5 10H4v3h2v-3h4v3h2v-3h.5A1.5 1.5 0 0 1 14 8.5v-2A1.5 1.5 0 0 0 12.5 5H12V2h-2z" /></svg>
);

const SkillsIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M8 1l2 5h5l-4 3 1.5 5L8 11l-4.5 3L5 9 1 6h5l2-5z" /></svg>
);

const AdvancedIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4"><path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z" /><path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z" /></svg>
);
