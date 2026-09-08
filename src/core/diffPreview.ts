import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import { applySearchReplace } from './searchReplace';

/**
 * Approval diff support (Cline-style "Open Diff" on file-edit approvals).
 *
 *  - computeFileEditDiff: computes the before/after strings a file-mutating
 *    tool WOULD produce, without touching disk, so the webview can render an
 *    inline preview and the host can open a real vscode.diff editor.
 *  - openApprovalDiff: lazily registers a TextDocumentContentProvider for the
 *    `fibonacci-diff` scheme and opens a vscode.diff of before vs after.
 *
 * The after-content prediction mirrors the real tool executors:
 *  - write_to_file    → args.content replaces the whole file
 *  - append_to_file   → before + (\n when needed) + args.content
 *  - insert_at_line   → splice args.content at args.line (1-based)
 *  - delete_lines     → remove args.start_line..args.end_line (1-based, inclusive)
 *  - replace_in_file  → SEARCH/REPLACE blocks via applySearchReplace
 *  - format_code      → touches the file but content is unknown → after = before
 */

/** Tools that mutate a file on disk (checkpoint + auto-diagnostics + diff set). */
export const FILE_MUTATING_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
  'format_code',
]);

/** Cap each side of the diff so a huge file can't blow up the webview. */
const MAX_DIFF_CHARS = 200 * 1024;

function capString(s: string): string {
  if (s.length <= MAX_DIFF_CHARS) return s;
  return s.slice(0, MAX_DIFF_CHARS) + '\n…[truncated]';
}

export interface FileEditDiff {
  path: string;
  before: string;
  after: string;
}

/**
 * Read the current disk content as `before` ('' when the file doesn't exist
 * yet) and predict `after` per tool semantics. Never writes and never throws.
 */
export async function computeFileEditDiff(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<FileEditDiff> {
  const rel = String(args.path ?? '');
  const root = nodePath.resolve(workspaceRoot);
  const abs = nodePath.resolve(root, rel);

  let before = '';
  let existed = false;
  try {
    if (rel && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      existed = true;
      before = fs.readFileSync(abs, 'utf-8');
    }
  } catch {
    before = '';
    existed = false;
  }

  let after = before;
  let note = '';

  switch (toolName) {
    case 'write_to_file':
      after = String(args.content ?? '');
      break;

    case 'append_to_file': {
      const content = String(args.content ?? '');
      // Mirror the append_to_file executor: it prepends a newline when the
      // file exists, is non-empty and doesn't already end with one.
      const prepend =
        existed && args.newline !== false && before.length > 0 && !before.endsWith('\n')
          ? '\n'
          : '';
      after = before + prepend + content;
      break;
    }

    case 'insert_at_line': {
      const line = Math.max(1, Math.floor(Number(args.line) || 1));
      const content = String(args.content ?? '');
      const lines = before.split('\n');
      const idx = Math.min(line - 1, lines.length);
      lines.splice(idx, 0, ...content.split('\n'));
      after = lines.join('\n');
      break;
    }

    case 'delete_lines': {
      // The executor schema uses start_line/end_line; accept start/end as a
      // defensive fallback for models that guess the arg name.
      const start = Math.max(1, Math.floor(Number(args.start_line ?? args.start) || 1));
      const end = Math.max(start, Math.floor(Number(args.end_line ?? args.end) || start));
      const lines = before.split('\n');
      if (start > lines.length) {
        note = `start_line ${start} is past end of file (${lines.length} lines)`;
        break;
      }
      const delCount = Math.min(end - start + 1, lines.length - start + 1);
      lines.splice(start - 1, delCount);
      after = lines.join('\n');
      break;
    }

    case 'replace_in_file': {
      try {
        after = applySearchReplace(before, String(args.diff ?? args.content ?? ''));
      } catch (err) {
        // Can't predict reliably (SEARCH block not found / ambiguous) — fall
        // back to "no change" and surface the reason as a note.
        note = err instanceof Error ? err.message : String(err);
      }
      break;
    }

    case 'format_code':
    default:
      // Content unknown until executed (format_code) — preview shows no change.
      after = before;
      break;
  }

  if (note) {
    after = after + (after.endsWith('\n') || !after ? '' : '\n') + `\n…[diff preview unavailable: ${note}]`;
  }

  return { path: rel, before: capString(before), after: capString(after) };
}

// ── vscode.diff support ─────────────────────────────────────────────────────

const DIFF_SCHEME = 'fibonacci-diff';
/** Cap the content cache so repeated approvals don't grow it unboundedly. */
const MAX_DIFF_CACHE_ENTRIES = 40;

let diffProviderRegistered = false;
const diffContents = new Map<string, string>();

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    // The uri query carries the cache key (generated id).
    return diffContents.get(uri.query) ?? '';
  }
}

function nextDiffId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The two virtual document URIs backing one opened diff editor. */
export interface OpenedDiffUris {
  before: vscode.Uri;
  after: vscode.Uri;
}

/**
 * Open a real diff editor for the given before/after strings. The contents
 * live in a module-level Map keyed by a generated id which is carried in the
 * uri query (keeps uris short and avoids escaping issues).
 *
 * Returns the two virtual URIs so callers can close the tabs later
 * (see closeDiffTabs).
 */
export function openDiffEditor(
  path: string,
  before: string,
  after: string,
  opts?: { title?: string; preserveFocus?: boolean }
): OpenedDiffUris {
  const uris = registerDiffUris(path, before, after);
  try {
    void vscode.commands.executeCommand(
      'vscode.diff',
      uris.before,
      uris.after,
      opts?.title ?? `${path} (Fibonacci Diff)`,
      { preview: false, preserveFocus: opts?.preserveFocus ?? false }
    );
  } catch (err) {
    console.error('[fibonacci-agent] openDiffEditor failed:', err);
  }
  return uris;
}

/** Register the before/after virtual docs without opening an editor yet. */
export function registerDiffUris(path: string, before: string, after: string): OpenedDiffUris {
  if (!diffProviderRegistered) {
    diffProviderRegistered = true;
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      new DiffContentProvider()
    );
  }
  while (diffContents.size >= MAX_DIFF_CACHE_ENTRIES * 2) {
    const oldest = diffContents.keys().next().value;
    if (oldest === undefined) break;
    diffContents.delete(oldest);
  }
  const beforeId = `${nextDiffId()}-b`;
  const afterId = `${nextDiffId()}-a`;
  diffContents.set(beforeId, before);
  diffContents.set(afterId, after);
  const encoded = encodeURIComponent(path || 'file');
  return {
    before: vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/before/${encoded}`, query: beforeId }),
    after: vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/after/${encoded}`, query: afterId }),
  };
}

/**
 * Best-effort close of diff editor tabs whose "modified" side matches the
 * given URI. Used to clean up preview/live diffs after approval/rejection.
 */
export async function closeDiffTabs(afterUri: vscode.Uri): Promise<void> {
  try {
    const target = afterUri.toString();
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((tab) => {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) return false;
        return tab.input.modified.toString() === target;
      });
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs, true);
    }
  } catch {
    /* closing is best-effort — never surface */
  }
}

/** Back-compat wrapper: open an approval diff (fire-and-forget). */
export function openApprovalDiff(path: string, before: string, after: string): void {
  openDiffEditor(path, before, after, { title: `${path} (Approval Diff)` });
}

// ── diff stats (+added / -removed) ──────────────────────────────────────────

export interface DiffLineStats {
  added: number;
  removed: number;
}

/** Max lines per side for the exact O(n·m) LCS count. */
const MAX_STATS_LCS_LINES = 2000;

/**
 * Kilo-style "+N -M" line stats for the tool-call header. Exact via LCS for
 * reasonably sized files; falls back to a cheap multiset approximation for
 * huge ones. Never throws.
 */
export function countDiffStats(before: string, after: string): DiffLineStats {
  try {
    const a = before.length > 0 ? before.split('\n') : [];
    const b = after.length > 0 ? after.split('\n') : [];

    if (a.length > MAX_STATS_LCS_LINES || b.length > MAX_STATS_LCS_LINES) {
      // Multiset fallback — O(n+m), close enough for a summary chip.
      const counts = new Map<string, number>();
      for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
      let added = 0;
      for (const line of b) {
        const c = counts.get(line) ?? 0;
        if (c > 0) counts.set(line, c - 1);
        else added++;
      }
      let removed = 0;
      for (const c of counts.values()) removed += c;
      return { added, removed };
    }

    // Rolling-row LCS length — memory O(m).
    const m = b.length;
    const prev = new Uint32Array(m + 1);
    const curr = new Uint32Array(m + 1);
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= m; j++) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      for (let j = 0; j <= m; j++) {
        prev[j] = curr[j];
        curr[j] = 0;
      }
    }
    const lcs = prev[m];
    return { added: b.length - lcs, removed: a.length - lcs };
  } catch {
    return { added: 0, removed: 0 };
  }
}
