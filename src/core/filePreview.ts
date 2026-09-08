import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { computeFileEditDiff, openDiffEditor, closeDiffTabs, type OpenedDiffUris } from './diffPreview';

/**
 * FilePreviewManager — shows file edits in the OFFICIAL VS Code diff editor
 * BEFORE anything is written to disk (Kilo Code / Cline style).
 *
 * Flow for write_to_file / replace_in_file / insert_at_line / delete_lines /
 * append_to_file:
 *   a. Compute the predicted before/after content (computeFileEditDiff —
 *      mirrors the real tool executors, never touches disk).
 *   b. Open a real `vscode.diff` editor: original vs incoming. The user can
 *      review the red/green diff while deciding.
 *   c. Return a handle. The agent loop asks for approval.
 *   d. If approved: commitPreview() writes the final content to disk
 *      (with Windows EBUSY/EPERM retry logic).
 *   e. If rejected: revertPreview() closes the diff tab. There is nothing to
 *      restore — the disk was NEVER modified before approval.
 *
 * This is strictly safer than the old editor-typing flow, which created and
 * mutated real files pre-approval and needed a fragile revert/delete dance.
 */

export interface PreviewHandle {
  /** The workspace-relative path of the target file. */
  path: string;
  /** The absolute path on disk (commit target). */
  absPath: string;
  /** The original content. Empty string if the file didn't exist. */
  originalContent: string;
  /** Whether the file existed before the preview. */
  existed: boolean;
  /** The final content that will be saved on commit. */
  finalContent: string;
  /** The virtual URIs of the opened diff editor (best-effort closed on revert). */
  diffUris: OpenedDiffUris | null;
}

/**
 * Resolve a workspace-relative or absolute path to an absolute fs path.
 *
 * CRITICAL: Never use `process.cwd()` as a fallback — on Windows, when no
 * folder is open in VS Code, `process.cwd()` returns the VS Code installation
 * directory, which requires Administrator privileges to write to. Instead we
 * fall back to `~/Documents/fibonacci-agent/` (auto-created), matching the
 * logic in `fileTools.ts`.
 */
function resolvePath(p: string, workspaceRoot?: string): string {
  // 1. If the caller provided a workspaceRoot (from the agent loop / context),
  //    use it as the base for relative paths. CRITICAL FIX (bug L2): ensure
  //    it exists before resolving against it.
  if (workspaceRoot) {
    try {
      if (!fs.existsSync(workspaceRoot)) {
        fs.mkdirSync(workspaceRoot, { recursive: true });
      }
    } catch (err) {
      console.error('[fibonacci-agent] Failed to create workspace root:', err);
    }
    if (fs.existsSync(workspaceRoot)) {
      if (!p) return workspaceRoot;
      if (path.isAbsolute(p)) return p;
      return path.resolve(workspaceRoot, p);
    }
  }

  // 2. If a VS Code workspace folder is open, use it.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    if (!p) return folder;
    if (path.isAbsolute(p)) return p;
    return path.resolve(folder, p);
  }

  // 3. Fall back to ~/Documents/fibonacci-agent/ (NOT process.cwd()).
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
    } catch {
      /* ignore — will fail later when trying to write */
    }
  }
  if (!p) return fallbackDir;
  if (path.isAbsolute(p)) return p;
  return path.resolve(fallbackDir, p);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function writeFileSyncWithRetry(
  filePath: string,
  data: string,
  encoding: BufferEncoding = 'utf-8',
  maxRetries = 5
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.writeFileSync(filePath, data, encoding);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      // Retry on EBUSY, EPERM, ENOTEMPTY (Windows lock errors).
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        // Exponential backoff: 20ms, 40ms, 80ms, 160ms, 320ms
        const delay = 20 * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH/REPLACE diff application (copied from fileTools.ts to avoid circular import)
// ─────────────────────────────────────────────────────────────────────────────

// SEARCH/REPLACE logic lives in ./searchReplace (pure, VS Code-free, tested)
export { applySearchReplace } from './searchReplace';

// ─────────────────────────────────────────────────────────────────────────────
// Tool name → preview function mapping
// ─────────────────────────────────────────────────────────────────────────────

/** The set of tools that use the preview-then-commit flow. */
export const PREVIEW_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
]);

/**
 * Run the preview phase for a file-writing tool: compute the predicted
 * before/after and open the official VS Code diff editor. Returns a handle
 * that must be passed to commitPreview() or revertPreview().
 */
export async function previewToolCall(
  toolName: string,
  args: Record<string, unknown>,
  _signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  if (!PREVIEW_TOOLS.has(toolName)) {
    throw new Error(`No preview available for tool: ${toolName}`);
  }

  const rel = String(args.path ?? '');
  const absPath = resolvePath(rel, workspaceRoot);

  // Did the file exist before? (Only used for messaging — nothing on disk
  // changes during preview, so there is no delete-on-revert case anymore.)
  let existed = false;
  try {
    existed = rel !== '' && fs.existsSync(absPath) && fs.statSync(absPath).isFile();
  } catch {
    existed = false;
  }

  // Predict before/after WITHOUT touching disk (mirrors the real executors).
  const diff = await computeFileEditDiff(toolName, args, workspaceRoot ?? resolvePath(''));

  // Open the official VS Code diff editor (original vs incoming).
  let diffUris: OpenedDiffUris | null = null;
  try {
    diffUris = openDiffEditor(rel || 'file', diff.before, diff.after, {
      title: `${rel} (Fibonacci Diff)`,
      preserveFocus: true,
    });
  } catch (err) {
    console.error('[fibonacci-agent] Failed to open preview diff:', err);
  }

  return {
    path: rel,
    absPath,
    originalContent: diff.before,
    existed,
    finalContent: diff.after,
    diffUris,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit / Revert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit a preview: write the final content to disk.
 *
 * The authoritative content is ALWAYS `handle.finalContent` (predicted from
 * the tool call args — the model's full intended content). There is no editor
 * to fall out of sync anymore, which eliminates the entire truncated-save
 * bug class (old bug G) by construction.
 */
export async function commitPreview(handle: PreviewHandle): Promise<void> {
  // Ensure the parent directory exists (mirrors the real executors).
  const dir = path.dirname(handle.absPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error('[fibonacci-agent] Failed to create parent directory:', err);
    // Continue — the write below will surface a proper error if this failed.
  }

  await writeFileSyncWithRetry(handle.absPath, handle.finalContent);
}

/**
 * Revert a preview: close the diff editor tab. The disk was never modified
 * before approval, so there is nothing to restore or delete.
 */
export async function revertPreview(handle: PreviewHandle): Promise<void> {
  if (!handle.diffUris) return;
  await closeDiffTabs(handle.diffUris.after);
}
