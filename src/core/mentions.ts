import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as nodePath from 'path';

/**
 * @-mention resolution (Cline/Kilo-style context pickers).
 *
 * The webview lets the user type @path/to/file, @problems or @git-changes in
 * the composer. Before the run starts, the host expands those tokens into
 * inline context blocks appended to the user message, so the model sees the
 * referenced material without extra tool round-trips.
 *
 * Guards:
 *  - max 3 file mentions per message, 8 KB per file, 24 KB total appended
 *  - never expands inside an existing context block (idempotent)
 */

export interface MentionResolution {
  /** The user content, possibly with appended context blocks. */
  content: string;
  /** Human-readable note about what was (not) expanded. */
  notes: string[];
}

const MENTION_RE = /(^|\s)@((?:[\w./\\-]+\.[A-Za-z0-9]+)|problems|git-changes|git)/g;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 8 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024;

function codeBlock(tag: string, body: string): string {
  return `\n\n<${tag}>\n${body.trimEnd()}\n</${tag}>`;
}

/** Expand @-mentions in the LAST user message of a run. */
export async function resolveMentions(
  content: string,
  workspaceRoot: string
): Promise<MentionResolution> {
  const notes: string[] = [];
  if (!content.includes('@') || content.includes('<file_context') || content.includes('<workspace_problems')) {
    return { content, notes };
  }

  const seen = new Set<string>();
  const fileMentions: string[] = [];
  let hasProblems = false;
  let hasGit = false;

  for (const match of content.matchAll(MENTION_RE)) {
    const token = match[2];
    if (token === 'problems') hasProblems = true;
    else if (token === 'git' || token === 'git-changes') hasGit = true;
    else if (fileMentions.length < MAX_FILES && !seen.has(token)) {
      seen.add(token);
      fileMentions.push(token);
    }
  }

  if (!hasProblems && !hasGit && fileMentions.length === 0) return { content, notes };

  let appended = '';
  let totalBytes = 0;

  // --- File mentions -------------------------------------------------------
  for (const rel of fileMentions) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      notes.push(`@${rel}: context budget exhausted, skipped`);
      continue;
    }
    const abs = nodePath.resolve(workspaceRoot, rel);
    const root = nodePath.resolve(workspaceRoot);
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) {
      notes.push(`@${rel}: outside workspace`);
      continue;
    }
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        notes.push(`@${rel}: file not found`);
        continue;
      }
      const buf = fs.readFileSync(abs);
      const slice = buf.length > MAX_FILE_BYTES
        ? buf.subarray(0, MAX_FILE_BYTES).toString('utf-8') + '\n…[truncated]'
        : buf.toString('utf-8');
      totalBytes += Buffer.byteLength(slice, 'utf-8');
      appended += codeBlock(`file_context path="${rel}"`, slice);
    } catch (err) {
      notes.push(`@${rel}: read failed`);
    }
  }

  // --- @problems -----------------------------------------------------------
  if (hasProblems && totalBytes < MAX_TOTAL_BYTES) {
    try {
      const diags = vscode.languages.getDiagnostics();
      const errors: string[] = [];
      for (const [uri, items] of diags) {
        for (const d of items) {
          if (d.severity !== vscode.DiagnosticSeverity.Error) continue;
          const rel = vscode.workspace.asRelativePath(uri, false);
          errors.push(`${rel}:${d.range.start.line + 1} — ${d.message.split('\n')[0]}`);
          if (errors.length >= 20) break;
        }
        if (errors.length >= 20) break;
      }
      appended += codeBlock(
        'workspace_problems',
        errors.length ? errors.join('\n') : 'No errors detected in the workspace.'
      );
    } catch {
      notes.push('@problems: diagnostics unavailable');
    }
  }

  // --- @git / @git-changes ---------------------------------------------------
  if (hasGit && totalBytes < MAX_TOTAL_BYTES) {
    const gitOut = await new Promise<string>((resolve) => {
      exec(
        'git status --porcelain && echo "---" && git diff --stat HEAD',
        { cwd: workspaceRoot, timeout: 4000, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : stdout ?? '')
      );
    });
    appended += codeBlock(
      'git_changes',
      gitOut.trim()
        ? gitOut.slice(0, 4 * 1024)
        : 'No git repository or no changes detected.'
    );
  }

  if (!appended) return { content, notes };
  return { content: content + appended, notes };
}
