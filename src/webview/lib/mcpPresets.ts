// Static registry of well-known MCP server presets for the Marketplace UI
// (McpSection). Pure data — no React, no host imports.
//
// BILINGUAL STRING DECISION: descriptions live in i18n/translations.ts under
// `mcpMarket.items.<id>.desc` (fa + en), NOT as `desc: {fa, en}` literals
// here — the whole webview resolves user-facing strings through t(), so
// keeping them in the dictionaries preserves the single-source-of-truth
// convention (and the key-count sanity check covers them).

/** Command/args/env follow the official modelcontextprotocol servers repo. */
export interface McpPreset {
  /** Stable id — also the i18n key suffix (mcpMarket.items.<id>.desc). */
  id: string;
  /** Display name — becomes the McpServerConfig.name when added. */
  name: string;
  /** Single emoji icon shown on the card. */
  emoji: string;
  /** Executable, e.g. "npx" / "uvx". */
  command: string;
  /** Command arguments. */
  args: string[];
  /**
   * Env vars the server needs. Empty-string values are INTENTIONAL: the
   * server is added with placeholder entries so the user fills the token in
   * afterwards (re-add via the JSON importer with the real value).
   */
  env?: Record<string, string>;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    emoji: '📁',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    emoji: '🌐',
    command: 'uvx',
    args: ['mcp-server-fetch'],
  },
  {
    id: 'memory',
    name: 'Memory',
    emoji: '🧠',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    emoji: '🧩',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    id: 'git',
    name: 'Git',
    emoji: '🔀',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '.'],
  },
  {
    id: 'github',
    name: 'GitHub',
    emoji: '🐙',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    emoji: '🦊',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: '' },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    emoji: '🐘',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    emoji: '💾',
    command: 'uvx',
    args: ['mcp-server-sqlite', '--db-path', './data.db'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    emoji: '🎭',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    id: 'slack',
    name: 'Slack',
    emoji: '💬',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    emoji: '📗',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
  },
];

/** "npx -y @modelcontextprotocol/server-filesystem /path/to/dir" for the card preview. */
export function presetCommandLine(p: McpPreset): string {
  return [p.command, ...p.args].filter(Boolean).join(' ');
}
