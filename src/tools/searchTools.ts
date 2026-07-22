import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * High-power search tools:
 *  - grep_search: fast regex content search with optional context lines
 *  - glob_files: filename pattern matching (like ripgrep --files | grep pattern)
 *
 * Both honor .gitignore-style exclusions and have hard size/timeout limits.
 */

// Re-use the ignore list from fileTools via a local copy (avoids circular import).
const IGNORED_SEGMENTS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'out-webview',
  '.vscode-test',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  'coverage',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  'env',
];

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.mdb',
  '.class', '.jar', '.war',
  '.pyc', '.pyo',
]);

function getCurrentWorkspaceRoot(): string {
  // CRITICAL FIX (bug L2): Ensure the workspace folder EXISTS before using it.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    try {
      if (!fsSync.existsSync(folder)) {
        fsSync.mkdirSync(folder, { recursive: true });
      }
      if (fsSync.existsSync(folder)) return folder;
    } catch {
      // fall through
    }
  }
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fsSync.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fsSync.existsSync(fallbackDir)) {
    try { fsSync.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
  }
  return fallbackDir;
}

function resolveWorkspacePath(p: string, workspaceRoot: string): string {
  if (!p) return workspaceRoot;
  if (path.isAbsolute(p)) return p;
  return path.resolve(workspaceRoot, p);
}

function isIgnored(filePath: string, workspaceRoot: string): boolean {
  try {
    const rel = path.relative(workspaceRoot, filePath);
    if (!rel || rel.startsWith('..')) return false;
    if (IGNORED_SEGMENTS.some((seg) => rel === seg || rel.startsWith(seg + path.sep))) {
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTS.has(ext)) return true;
    return false;
  } catch {
    return false;
  }
}

async function* walk(dir: string, workspaceRoot: string): AsyncIterable<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnored(full, workspaceRoot)) continue;
      yield* walk(full, workspaceRoot);
    } else if (entry.isFile()) {
      if (isIgnored(full, workspaceRoot)) continue;
      yield full;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

export const searchToolDefinitions: ToolDefinition[] = [
  {
    name: 'grep_search',
    category: 'search',
    description:
      'Fast regex content search across files. Returns matching lines with optional context (lines before/after). Honors .gitignore-style exclusions. Use this instead of search_files when you need regex, context lines, or glob filtering. Patterns are JavaScript RegExp (e.g. "function\\s+\\w+", "TODO|FIXME").',
    parameters: schema(
      {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'Directory to search in (default: workspace root)',
        },
        glob: {
          type: 'string',
          description: 'Filename glob to filter (e.g. "*.ts", "**/*.py"). Default: all files.',
        },
        context: {
          type: 'number',
          description: 'Number of context lines before and after each match (default: 0)',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive search (default: false)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of matches to return (default: 100)',
        },
      },
      ['pattern']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['search', 'read'],
  },
  {
    name: 'glob_files',
    category: 'search',
    description:
      'Find files by name pattern (like `find` with globs). Supports ** for recursive matching. Honors .gitignore-style exclusions. Use this when you know the filename pattern but not the path (e.g. find all "*.test.ts" files, or all "README*" files).',
    parameters: schema(
      {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.json", "*.md")',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (default: workspace root)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of files to return (default: 200)',
        },
      },
      ['pattern']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['search', 'read'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerSearchTools(registry: ToolRegistry): void {
  registry.register(searchToolDefinitions[0], async (args, ctx) => {
    const wsRoot = getCurrentWorkspaceRoot();
    const target = resolveWorkspacePath(String(args.path ?? wsRoot), wsRoot);
    const pattern = String(args.pattern);
    const globFilter = args.glob ? String(args.glob) : null;
    const contextLines = Math.min(10, Math.max(0, Number(args.context ?? 0)));
    const caseInsensitive = args.case_insensitive === true;
    const max = Math.min(1000, Math.max(1, Number(args.max_results ?? 100)));

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
    } catch (err) {
      return {
        ok: false,
        output: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const globMatcher = globFilter ? compileGlob(globFilter) : null;

    const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
    const MAX_FILES = 2000;
    const MAX_TOTAL_LINES = 500_000;
    const TIMEOUT_MS = 30_000;
    const startTime = Date.now();

    const results: string[] = [];
    let filesScanned = 0;
    let totalLines = 0;
    let truncated = false;

    try {
      for await (const f of walk(target, wsRoot)) {
        if (ctx?.signal?.aborted) break;
        if (Date.now() - startTime > TIMEOUT_MS) {
          truncated = true;
          break;
        }
        if (filesScanned >= MAX_FILES) {
          truncated = true;
          break;
        }
        if (totalLines >= MAX_TOTAL_LINES) {
          truncated = true;
          break;
        }

        const relPath = path.relative(wsRoot, f) || f;
        if (globMatcher && !globMatcher(relPath)) continue;

        let stat: fsSync.Stats;
        try {
          stat = await fs.stat(f);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

        let content: string;
        try {
          // Quick binary check
          const handle = await fs.open(f, 'r');
          const buf = Buffer.alloc(Math.min(512, stat.size));
          await handle.read(buf, 0, buf.length, 0);
          await handle.close();
          if (buf.includes(0)) continue;
          content = await fs.readFile(f, 'utf-8');
        } catch {
          continue;
        }

        filesScanned++;
        const lines = content.split('\n');
        totalLines += lines.length;

        regex.lastIndex = 0;
        for (let i = 0; i < lines.length; i++) {
          if (ctx?.signal?.aborted) break;
          if (results.length >= max) {
            truncated = true;
            break;
          }
          const line = lines[i];
          if (line.length > 2000) continue;
          regex.lastIndex = 0;
          if (regex.test(line)) {
            if (contextLines > 0) {
              const start = Math.max(0, i - contextLines);
              const end = Math.min(lines.length - 1, i + contextLines);
              const ctxLines: string[] = [];
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? '>' : ' ';
                ctxLines.push(`${prefix} ${relPath}:${j + 1}: ${lines[j]}`);
              }
              results.push(ctxLines.join('\n'));
            } else {
              results.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 300)}`);
            }
          }
        }
        if (results.length >= max) break;
      }
    } catch (err) {
      return {
        ok: false,
        output: `Search error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const summary = `[scanned ${filesScanned} files in ${Date.now() - startTime}ms${truncated ? ' — truncated' : ''}]`;
    if (results.length === 0) {
      return { ok: true, output: `${summary}\n(no matches for /${pattern}/)` };
    }
    return { ok: true, output: `${summary}\n${results.join('\n\n')}` };
  });

  registry.register(searchToolDefinitions[1], async (args, ctx) => {
    const wsRoot = getCurrentWorkspaceRoot();
    const target = resolveWorkspacePath(String(args.path ?? wsRoot), wsRoot);
    const pattern = String(args.pattern);
    const max = Math.min(2000, Math.max(1, Number(args.max_results ?? 200)));

    const matcher = compileGlob(pattern);
    const results: string[] = [];
    const startTime = Date.now();
    let filesScanned = 0;
    let truncated = false;

    try {
      for await (const f of walk(target, wsRoot)) {
        if (ctx?.signal?.aborted) break;
        if (Date.now() - startTime > 30_000) {
          truncated = true;
          break;
        }
        if (filesScanned >= 5000) {
          truncated = true;
          break;
        }
        filesScanned++;
        const relPath = path.relative(wsRoot, f) || f;
        if (matcher(relPath)) {
          results.push(relPath);
          if (results.length >= max) {
            truncated = true;
            break;
          }
        }
      }
    } catch (err) {
      return {
        ok: false,
        output: `Glob error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const summary = `[scanned ${filesScanned} files in ${Date.now() - startTime}ms${truncated ? ' — truncated' : ''}]`;
    if (results.length === 0) {
      return { ok: true, output: `${summary}\n(no files match ${pattern})` };
    }
    return { ok: true, output: `${summary}\n${results.join('\n')}` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob → RegExp compiler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (matches anything except /), ** (matches everything including /),
 * ? (matches one char except /), and literal characters.
 */
function compileGlob(glob: string): (s: string) => boolean {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') i++;
      re += '.*';
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else if ('+()[]{}^$|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  const regex = new RegExp(re);
  return (s: string) => regex.test(s);
}
