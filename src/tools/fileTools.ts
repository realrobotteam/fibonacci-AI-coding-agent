import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../types';
import { schema, type ToolContext } from '../core/toolRegistry';
import { structuredPatch } from 'diff';

/**
 * File operations: read / write / replace / list / search.
 * All operations honor `.gitignore` for `list_files` and `search_files`.
 * Persian content is handled transparently because Node handles UTF-8.
 */

/**
 * Resolve the current workspace root at call time. Checks VS Code's open
 * workspace folder first, then falls back to ~/Documents/fibonacci-agent
 * (created automatically on first use). This avoids writing files to the
 * VS Code installation directory when no folder is open.
 */
function getCurrentWorkspaceRoot(): string {
  // Check VS Code workspace first
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) return folder;
  // Fall back to ~/Documents/fibonacci-agent
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fsSync.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fsSync.existsSync(fallbackDir)) {
    try {
      fsSync.mkdirSync(fallbackDir, { recursive: true });
    } catch {
      /* ignore — will fail later when trying to write */
    }
  }
  return fallbackDir;
}

function resolveWorkspacePath(p: string, workspaceRoot: string): string {
  if (!p) return workspaceRoot;
  if (path.isAbsolute(p)) return p;
  return path.resolve(workspaceRoot, p);
}

/**
 * Open a file in VS Code's editor so the user can see the result of a write/edit.
 * Called after successful write_to_file and replace_in_file operations.
 */
async function openFileInEditor(filePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
  } catch (err) {
    // Don't fail the tool if the editor can't show the file — just log it.
    console.error('[fibonacci-agent] Failed to open file in editor:', err);
  }
}

async function isIgnored(filePath: string, workspaceRoot: string): Promise<boolean> {
  try {
    const rel = path.relative(workspaceRoot, filePath);
    if (!rel || rel.startsWith('..')) return false;
    // Comprehensive ignore list — these directories/files are never searched.
    const ignoredSegments = [
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
    if (ignoredSegments.some((seg) => rel === seg || rel.startsWith(seg + path.sep))) {
      return true;
    }
    // Skip binary/media file extensions
    const ext = path.extname(filePath).toLowerCase();
    const binaryExts = [
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
      '.exe', '.dll', '.so', '.dylib', '.bin', '.obj',
      '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
      '.sqlite', '.db', '.mdb',
      '.class', '.jar', '.war',
      '.pyc', '.pyo',
    ];
    if (binaryExts.includes(ext)) return true;
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
      if (await isIgnored(full, workspaceRoot)) continue;
      yield* walk(full, workspaceRoot);
    } else if (entry.isFile()) {
      if (await isIgnored(full, workspaceRoot)) continue;
      yield full;
    }
  }
}

export const fileToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    category: 'file',
    description:
      'Read the content of a text file. Handles UTF-8 correctly (including Persian/Arabic text).',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path (relative to workspace root, or absolute)' },
        start_line: { type: 'number', description: 'Start line (optional, 1-indexed)' },
        end_line: { type: 'number', description: 'End line (optional)' },
      },
      ['path']
    ),
    requiresApproval: false,
    readOnly: true,
  },
  {
    name: 'write_to_file',
    category: 'file',
    description: 'Create a new file or fully overwrite an existing one. Persian content is supported.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full file content' },
      },
      ['path', 'content']
    ),
    requiresApproval: true,
  },
  {
    name: 'replace_in_file',
    category: 'file',
    description:
      'Surgical edit of an existing file using SEARCH/REPLACE blocks. Format: <<<<<<< SEARCH\\nold text\\n=======\\nnew text\\n>>>>>>> REPLACE. Multiple blocks can be chained in one call.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        diff: { type: 'string', description: 'SEARCH/REPLACE block(s)' },
      },
      ['path', 'diff']
    ),
    requiresApproval: true,
  },
  {
    name: 'list_files',
    category: 'file',
    description: 'List the contents of a directory. Files ignored by .gitignore are excluded.',
    parameters: schema(
      {
        path: { type: 'string', description: 'Directory path (default: workspace root)' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories? (default: false)' },
      }
    ),
    requiresApproval: false,
    readOnly: true,
  },
  {
    name: 'search_files',
    category: 'file',
    description: 'Search file contents across text files. Supports regex and matches Persian text correctly.',
    parameters: schema(
      {
        path: { type: 'string', description: 'Search directory (default: workspace root)' },
        query: { type: 'string', description: 'Search term or regex' },
        is_regex: { type: 'boolean', description: 'Is query a regex? (default: false)' },
        max_results: { type: 'number', description: 'Maximum number of results (default: 50)' },
      },
      ['query']
    ),
    requiresApproval: false,
    readOnly: true,
  },
];

const SEARCH_REPLACE_RE =
  /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

export function applySearchReplace(original: string, diff: string): string {
  let result = original;
  let matches = 0;
  let m: RegExpExecArray | null;
  SEARCH_REPLACE_RE.lastIndex = 0;
  while ((m = SEARCH_REPLACE_RE.exec(diff)) !== null) {
    const [, search, replace] = m;
    const idx = result.indexOf(search);
    if (idx === -1) {
      throw new Error(
        `SEARCH block not found. Make sure the text matches the file exactly:\n${search.slice(0, 120)}…`
      );
    }
    result = result.slice(0, idx) + replace + result.slice(idx + search.length);
    matches++;
  }
  if (matches === 0) {
    throw new Error('No valid SEARCH/REPLACE block found.');
  }
  return result;
}

export function createFileToolExecutors(_workspaceRoot: string) {
  // Note: we use getCurrentWorkspaceRoot() at call time instead of the
  // _workspaceRoot captured at activation, so that if the user opens/closes
  // folders after the extension is loaded, the path resolves correctly.
  return {
    read_file: async (args: Record<string, unknown>) => {
      const target = resolveWorkspacePath(String(args.path), getCurrentWorkspaceRoot());
      let content = await fs.readFile(target, 'utf-8');
      const startLine = args.start_line ? Number(args.start_line) : undefined;
      const endLine = args.end_line ? Number(args.end_line) : undefined;
      if (startLine || endLine) {
        const lines = content.split('\n');
        const start = (startLine ?? 1) - 1;
        const end = endLine ?? lines.length;
        content = lines.slice(start, end).join('\n');
        return { ok: true, output: content, meta: { lines: end - start } };
      }
      return { ok: true, output: content };
    },

    write_to_file: async (args: Record<string, unknown>) => {
      const target = resolveWorkspacePath(String(args.path), getCurrentWorkspaceRoot());
      const content = String(args.content ?? '');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf-8');
      // Auto-open the file in VS Code so the user can see the result.
      await openFileInEditor(target);
      return {
        ok: true,
        output: `File written successfully: ${target} (${content.length} characters). The file is now open in the editor.`,
      };
    },

    replace_in_file: async (args: Record<string, unknown>) => {
      const target = resolveWorkspacePath(String(args.path), getCurrentWorkspaceRoot());
      const original = await fs.readFile(target, 'utf-8');
      const updated = applySearchReplace(original, String(args.diff));
      await fs.writeFile(target, updated, 'utf-8');
      // Auto-open the file in VS Code so the user can see the edit.
      await openFileInEditor(target);
      // Produce a small unified diff so the LLM can verify its edit.
      const patch = structuredPatch(target, target, original, updated, '', '', { context: 2 });
      const lines: string[] = [];
      for (const hunk of patch.hunks) {
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        for (const l of hunk.lines) lines.push(l);
      }
      return {
        ok: true,
        output: `File edited: ${target}\n\n` + (lines.join('\n') || '(no changes)') + '\n\nThe file is now open in the editor.',
      };
    },

    list_files: async (args: Record<string, unknown>) => {
      const wsRoot = getCurrentWorkspaceRoot();
      const target = resolveWorkspacePath(
        String(args.path ?? wsRoot),
        wsRoot
      );
      const recursive = args.recursive !== false;
      const entries: string[] = [];
      if (recursive) {
        for await (const f of walk(target, wsRoot)) {
          entries.push(path.relative(wsRoot, f) || f);
          if (entries.length >= 500) break;
        }
      } else {
        const items = await fs.readdir(target, { withFileTypes: true });
        for (const it of items) {
          entries.push(it.isDirectory() ? `${it.name}/` : it.name);
        }
      }
      return { ok: true, output: entries.join('\n') || '(empty directory)' };
    },

    search_files: async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const wsRoot = getCurrentWorkspaceRoot();
      const target = resolveWorkspacePath(
        String(args.path ?? wsRoot),
        wsRoot
      );
      const query = String(args.query);
      const isRegex = args.is_regex === true;
      const max = Number(args.max_results ?? 50);
      const pattern = isRegex ? new RegExp(query, 'u') : null;
      const results: string[] = [];

      // Hard limits to prevent hanging on large workspaces
      const MAX_FILE_SIZE = 1024 * 1024; // 1 MB per file
      const MAX_FILES_SCANNED = 1000; // stop after this many files
      const MAX_TOTAL_LINES = 200_000; // stop after this many total lines
      const TIMEOUT_MS = 15_000; // overall timeout
      const startTime = Date.now();
      let filesScanned = 0;
      let totalLines = 0;

      try {
        for await (const f of walk(target, wsRoot)) {
          // Check abort + timeout
          if (ctx?.signal?.aborted) break;
          if (Date.now() - startTime > TIMEOUT_MS) {
            results.push(`[search timed out after ${TIMEOUT_MS}ms — partial results above]`);
            break;
          }
          if (filesScanned >= MAX_FILES_SCANNED) {
            results.push(`[stopped after scanning ${MAX_FILES_SCANNED} files — refine your query or path]`);
            break;
          }
          if (totalLines >= MAX_TOTAL_LINES) {
            results.push(`[stopped after ${MAX_TOTAL_LINES} lines — refine your query or path]`);
            break;
          }

          // Stat to check size (skip if too big)
          let fileSize: number;
          try {
            const statResult = await fs.stat(f);
            fileSize = statResult.size;
            if (fileSize > MAX_FILE_SIZE) continue;
            if (fileSize === 0) continue;
          } catch {
            continue;
          }

          let content: string;
          try {
            // Read only first 512 bytes to detect binary content quickly
            const handle = await fs.open(f, 'r');
            const buf = Buffer.alloc(Math.min(512, fileSize));
            await handle.read(buf, 0, buf.length, 0);
            await handle.close();
            // Detect binary: if it contains a NUL byte in the first 512 bytes, skip
            if (buf.includes(0)) continue;

            content = await fs.readFile(f, 'utf-8');
          } catch {
            continue;
          }

          filesScanned++;
          const lines = content.split('\n');
          totalLines += lines.length;

          for (let i = 0; i < lines.length; i++) {
            if (ctx?.signal?.aborted) break;
            const line = lines[i];
            // Skip very long lines (likely minified code)
            if (line.length > 2000) continue;
            const hit = pattern ? pattern.test(line) : line.includes(query);
            if (hit) {
              results.push(`${path.relative(wsRoot, f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
              if (results.length >= max) break;
            }
          }
          if (results.length >= max) break;
        }
      } catch (err) {
        return {
          ok: false,
          output: `Search error: ${err instanceof Error ? err.message : String(err)}. Partial results (${results.length}):\n${results.join('\n')}`,
        };
      }

      const summary = `[scanned ${filesScanned} files in ${Date.now() - startTime}ms]`;
      if (results.length === 0) {
        return { ok: true, output: `${summary}\n(no results found)` };
      }
      return { ok: true, output: `${summary}\n${results.join('\n')}` };
    },
  };
}

export function registerFileTools(
  registry: import('../core/toolRegistry').ToolRegistry,
  workspaceRoot: string
): void {
  const executors = createFileToolExecutors(workspaceRoot);
  for (const def of fileToolDefinitions) {
    registry.register(def, executors[def.name as keyof typeof executors]);
  }
}
