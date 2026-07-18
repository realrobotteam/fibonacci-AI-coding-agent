import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * Additional code-editing tools that complement write_to_file and
 * replace_in_file:
 *
 *  - insert_at_line: insert text at a specific line (existing content shifts down)
 *  - delete_lines:   delete a range of lines
 *  - append_to_file: append text to the end of a file (creates if missing)
 *
 * All three require approval (they modify files).
 */

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

function resolveWorkspacePath(p: string): string {
  if (!p) return getCurrentWorkspaceRoot();
  if (path.isAbsolute(p)) return p;
  return path.resolve(getCurrentWorkspaceRoot(), p);
}

async function openFileInEditor(filePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.One,
    });
  } catch (err) {
    console.error('[fibonacci-agent] Failed to open file in editor:', err);
  }
}

export const codeEditToolDefinitions: ToolDefinition[] = [
  {
    name: 'insert_at_line',
    category: 'file',
    description:
      'Insert text at a specific line in a file. Existing content from that line onwards shifts down. line=1 inserts at the top; line=N where N > line count appends to the end. The file is auto-opened in VS Code.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number (1-indexed) where the new text will be inserted' },
        content: { type: 'string', description: 'Text to insert' },
      },
      ['path', 'line', 'content']
    ),
    requiresApproval: true,
    tags: ['file', 'write'],
  },
  {
    name: 'delete_lines',
    category: 'file',
    description:
      'Delete a range of lines from a file (inclusive). start_line and end_line are 1-indexed. The file is auto-opened in VS Code.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'number', description: 'Start line (1-indexed, inclusive)' },
        end_line: { type: 'number', description: 'End line (1-indexed, inclusive)' },
      },
      ['path', 'start_line', 'end_line']
    ),
    requiresApproval: true,
    tags: ['file', 'write'],
  },
  {
    name: 'append_to_file',
    category: 'file',
    description:
      'Append text to the end of a file. If the file does not exist, it is created (like write_to_file). Useful for adding to log files, appending exports, or extending config files. The file is auto-opened in VS Code.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Text to append' },
        newline: {
          type: 'boolean',
          description: 'Prepend a newline before the appended text if the file is non-empty (default: true)',
        },
      },
      ['path', 'content']
    ),
    requiresApproval: true,
    tags: ['file', 'write'],
  },
];

export function registerCodeEditTools(registry: ToolRegistry): void {
  registry.register(codeEditToolDefinitions[0], async (args) => {
    const target = resolveWorkspacePath(String(args.path));
    const lineNum = Math.max(1, Number(args.line));
    const content = String(args.content ?? '');

    let original: string;
    try {
      original = await fs.readFile(target, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — create it with the content
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        await openFileInEditor(target);
        return {
          ok: true,
          output: `Created ${target} with ${content.length} characters at line 1.`,
        };
      }
      throw err;
    }

    const lines = original.split('\n');
    const insertIdx = Math.min(lineNum - 1, lines.length);
    const insertLines = content.split('\n');
    lines.splice(insertIdx, 0, ...insertLines);
    const updated = lines.join('\n');
    await fs.writeFile(target, updated, 'utf-8');
    await openFileInEditor(target);
    return {
      ok: true,
      output: `Inserted ${insertLines.length} line(s) at line ${insertIdx + 1} in ${target}. File now has ${lines.length} line(s).`,
    };
  });

  registry.register(codeEditToolDefinitions[1], async (args) => {
    const target = resolveWorkspacePath(String(args.path));
    const startLine = Math.max(1, Number(args.start_line));
    const endLine = Math.max(startLine, Number(args.end_line));

    let original: string;
    try {
      original = await fs.readFile(target, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        output: `Cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const lines = original.split('\n');
    if (startLine > lines.length) {
      return {
        ok: false,
        output: `start_line ${startLine} is past end of file (${lines.length} lines).`,
      };
    }
    const delCount = Math.min(endLine - startLine + 1, lines.length - startLine + 1);
    const removed = lines.splice(startLine - 1, delCount);
    const updated = lines.join('\n');
    await fs.writeFile(target, updated, 'utf-8');
    await openFileInEditor(target);
    return {
      ok: true,
      output: `Deleted ${delCount} line(s) from ${target} (L${startLine}-L${endLine}). File now has ${lines.length} line(s). Removed:\n${removed.join('\n').slice(0, 500)}`,
    };
  });

  registry.register(codeEditToolDefinitions[2], async (args) => {
    const target = resolveWorkspacePath(String(args.path));
    const content = String(args.content ?? '');
    const prependNewline = args.newline !== false;

    let existing = '';
    let existed = false;
    try {
      existing = await fs.readFile(target, 'utf-8');
      existed = true;
    } catch {
      // File doesn't exist — will create
    }

    const writeContent =
      existed && prependNewline && existing.length > 0 && !existing.endsWith('\n')
        ? '\n' + content
        : existed && prependNewline && existing.endsWith('\n')
          ? content
          : content;

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, writeContent, 'utf-8');
    await openFileInEditor(target);
    return {
      ok: true,
      output: `Appended ${content.length} character(s) to ${target}. File is now ${existed ? 'updated' : 'created'}.`,
    };
  });
}
