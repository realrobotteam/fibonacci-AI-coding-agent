import type { ToolDefinition } from '../types';
import { schema, type ToolContext } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * Git tools (read-only):
 *  - git_status: working tree status
 *  - git_diff: unstaged or staged diff
 *  - git_log: commit history
 *
 * All execute `git` as a child process with a hard timeout. They never modify
 * the repository.
 */

export const gitToolDefinitions: ToolDefinition[] = [
  {
    name: 'git_status',
    category: 'git',
    description:
      'Show the working tree status (modified, staged, untracked files). Read-only — equivalent to `git status --short`.',
    parameters: schema(
      {
        path: {
          type: 'string',
          description: 'Repository path (default: workspace root)',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['git', 'read'],
  },
  {
    name: 'git_diff',
    category: 'git',
    description:
      'Show unstaged changes (or staged changes with staged=true). Read-only. Output is truncated to 50KB.',
    parameters: schema(
      {
        path: {
          type: 'string',
          description: 'File or directory to diff (default: whole repo)',
        },
        staged: {
          type: 'boolean',
          description: 'Show staged (cached) changes instead of unstaged (default: false)',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['git', 'read'],
  },
  {
    name: 'git_log',
    category: 'git',
    description:
      'Show the commit log. Read-only. Default: last 20 commits, one-line format.',
    parameters: schema(
      {
        path: {
          type: 'string',
          description: 'File or directory to log (default: whole repo)',
        },
        limit: {
          type: 'number',
          description: 'Number of commits to show (default: 20, max: 100)',
        },
        oneline: {
          type: 'boolean',
          description: 'Use --oneline format (default: true)',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['git', 'read'],
  },
];

export function registerGitTools(registry: ToolRegistry): void {
  registry.register(gitToolDefinitions[0], async (args, ctx) => {
    return runGit(String(args.path ?? '.'), ['status', '--short', '--branch'], ctx);
  });

  registry.register(gitToolDefinitions[1], async (args, ctx) => {
    const staged = args.staged === true;
    const cmd = ['diff'];
    if (staged) cmd.push('--cached');
    if (args.path) cmd.push('--', String(args.path));
    return runGit('.', cmd, ctx);
  });

  registry.register(gitToolDefinitions[2], async (args, ctx) => {
    const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
    const oneline = args.oneline !== false;
    const cmd = ['log', `-${limit}`];
    if (oneline) cmd.push('--oneline');
    if (args.path) cmd.push('--', String(args.path));
    return runGit('.', cmd, ctx);
  });
}

async function runGit(
  cwd: string,
  args: string[],
  ctx?: ToolContext
): Promise<{ ok: boolean; output: string; meta?: Record<string, unknown> }> {
  const { execFile } = await import('node:child_process');
  // Resolve cwd to workspace root if relative
  const finalCwd = cwd || ctx?.workspaceRoot || process.cwd();

  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: finalCwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000,
        env: { ...process.env, GIT_PAGER: 'cat' },
      },
      (err, stdout, stderr) => {
        if (err) {
          // git exits with code 1 for empty diffs in some setups; treat as ok
          const combined = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
          if (combined.trim().length > 0) {
            resolve({ ok: true, output: combined.slice(0, 50_000) || '(no output)' });
          } else {
            resolve({
              ok: false,
              output: `git ${args.join(' ')} failed: ${err.message}`,
            });
          }
          return;
        }
        const out = ((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, 50_000);
        resolve({ ok: true, output: out || '(no output)' });
      }
    );
    ctx?.signal?.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    });
  });
}
