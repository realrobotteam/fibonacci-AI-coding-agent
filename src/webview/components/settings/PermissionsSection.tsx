import React, { useEffect, useMemo } from 'react';
import type { AgentConfig, AutoApproveMode } from '@shared/index';
import { postMessage as postToHost } from '../../vscodeApi';
import { useStore } from '../../store/useStore';
import type { ToolListItem } from '../../store/useStore';
import { Section, SettingRow, Select, Toggle, SectionHeader, EmptyState } from './ui';

const CATEGORY_COLORS: Record<string, string> = {
  file: 'text-file-read',
  terminal: 'text-terminal',
  mcp: 'text-mcp',
  web: 'text-web',
  search: 'text-search',
  git: 'text-git',
  editor: 'text-editor',
  reasoning: 'text-reasoning',
  skill: 'text-skill',
  meta: 'text-default',
};

export const PermissionsSection: React.FC<{
  config: AgentConfig;
  t: (k: string) => string;
}> = ({ config, t }) => {
  const toolList = useStore((s) => s.toolList);

  useEffect(() => {
    postToHost({ type: 'GET_TOOL_LIST' });
  }, []);

  const readOnlyTools = useMemo(() => toolList.filter((t) => t.readOnly), [toolList]);
  const writableTools = useMemo(() => toolList.filter((t) => !t.readOnly && !t.hidden), [toolList]);
  const groupedByCategory = useMemo(() => {
    const groups: Record<string, ToolListItem[]> = {};
    for (const tool of toolList) {
      if (tool.hidden) continue;
      if (!groups[tool.category]) groups[tool.category] = [];
      groups[tool.category].push(tool);
    }
    return groups;
  }, [toolList]);

  const overrides = config.toolOverrides ?? {};

  const setOverride = (toolName: string, forced: boolean) => {
    const newOverrides = { ...overrides };
    if (forced) {
      newOverrides[toolName] = true; // force require approval
    } else {
      delete newOverrides[toolName];
    }
    postToHost({ type: 'SET_CONFIG', key: 'toolOverrides', value: newOverrides });
  };

  const set = (key: string, value: unknown) => {
    postToHost({ type: 'SET_CONFIG', key, value });
  };

  return (
    <div className="space-y-8">
      {/* Global auto-approve mode */}
      <Section title={t('permissions.globalMode')}>
        <SettingRow
          label={t('settings.autoApproveMode')}
          description={t('permissions.globalMode.desc')}
        >
          <Select
            value={config.autoApproveMode}
            onChange={(v) => postToHost({ type: 'SET_AUTO_APPROVE_MODE', mode: v as AutoApproveMode })}
            options={[
              { value: 'none', label: t('autoApprove.none') },
              { value: 'read-only', label: t('autoApprove.readOnly') },
              { value: 'all', label: t('autoApprove.all') },
            ]}
          />
        </SettingRow>
      </Section>

      {/* Per-tool overrides */}
      <Section title={t('permissions.toolOverrides')}>
        <p className="text-2xs text-text-muted mb-2">{t('permissions.toolOverrides.desc')}</p>
        {Object.keys(groupedByCategory).length === 0 ? (
          <EmptyState message={t('permissions.noTools')} />
        ) : (
          <div className="space-y-3">
            {Object.entries(groupedByCategory).map(([category, tools]) => (
              <div key={category} className="space-y-1">
                <div className="text-2xs font-medium text-text-muted uppercase tracking-wider px-1">
                  {t(`tool.category.${category}`) || category}
                </div>
                {tools.map((tool) => {
                  const isOverridden = overrides[tool.name] === true;
                  const catColor = CATEGORY_COLORS[tool.category] ?? 'text-default';
                  return (
                    <div
                      key={tool.name}
                      className="flex items-center justify-between text-xs px-2.5 py-2 bg-input rounded-card border border-border-subtle hover:border-border-input transition-colors duration-fast"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className={`text-2xs font-mono ${catColor}`}>{tool.name}</span>
                        {tool.readOnly && (
                          <span className="text-2xs text-status-success bg-status-success/10 px-1 py-0.5 rounded">
                            {t('permissions.readOnly')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-2xs text-text-muted">
                          {isOverridden ? t('permissions.forceApproval') : t('permissions.followGlobal')}
                        </span>
                        <Toggle
                          checked={isOverridden}
                          onChange={(v) => setOverride(tool.name, v)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Read-only tools reference */}
      <Section title={t('permissions.readOnlyTools')}>
        <p className="text-2xs text-text-muted mb-2">{t('permissions.readOnlyTools.desc')}</p>
        {readOnlyTools.length === 0 ? (
          <EmptyState message={t('permissions.noReadOnlyTools')} />
        ) : (
          <div className="space-y-1">
            {readOnlyTools.map((tool) => (
              <div
                key={tool.name}
                className="flex items-center gap-2 text-xs px-2.5 py-1.5 bg-input rounded-card border border-border-subtle"
              >
                <span className={`text-2xs font-mono ${CATEGORY_COLORS[tool.category] ?? 'text-default'}`}>
                  {tool.name}
                </span>
                <span className="text-2xs text-status-success bg-status-success/10 px-1 py-0.5 rounded">
                  {t('permissions.readOnly')}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
