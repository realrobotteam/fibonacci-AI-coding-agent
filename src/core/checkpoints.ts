import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { CheckpointMeta } from '../types';

function cryptoRandom(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Cline-style checkpoints: before every file-mutating tool executes we
 * snapshot the target files so the user can restore the workspace to that
 * instant with one click (per-message restore button in the webview).
 *
 * Storage: in-memory ring buffer, mirrored to globalState with strict size
 * budgets so VS Code's state DB never balloons:
 *  - max 30 checkpoints (oldest evicted)
 *  - per-file content cap 256 KB, total per-checkpoint cap 1 MB
 *  - total mirrored budget 8 MB
 */
export interface FileSnapshot {
  /** Workspace-relative path. */
  path: string;
  /** Whether the file existed on disk before the tool ran. */
  existed: boolean;
  /** Previous content (utf-8) when existed, else empty. */
  content: string;
}

const MAX_CHECKPOINTS = 30;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const STATE_KEY = 'fibonacci.checkpoints';

interface StoredCheckpoint {
  meta: CheckpointMeta;
  files: FileSnapshot[];
}

export interface RestoreResult {
  restored: number;
  errors: string[];
}

export class CheckpointManager {
  private checkpoints: StoredCheckpoint[] = [];
  private loaded = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Load from globalState once per session (lazy). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = this.context.globalState.get<StoredCheckpoint[]>(STATE_KEY);
      if (Array.isArray(raw)) this.checkpoints = raw;
    } catch {
      this.checkpoints = [];
    }
  }

  private persist(): void {
    // Enforce the global byte budget before writing.
    let total = 0;
    const kept: StoredCheckpoint[] = [];
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const c = this.checkpoints[i];
      const bytes = c.files.reduce((s, f) => s + Buffer.byteLength(f.content, 'utf-8'), 0);
      total += bytes;
      if (total <= MAX_TOTAL_BYTES) kept.unshift(c);
    }
    this.checkpoints = kept;
    void this.context.globalState.update(STATE_KEY, this.checkpoints);
  }

  /** Resolve a workspace-relative path to an absolute fs path (or null outside root). */
  private toAbsolute(workspaceRoot: string, rel: string): string | null {
    const abs = nodePath.resolve(workspaceRoot, rel);
    const root = nodePath.resolve(workspaceRoot);
    if (abs !== root && !abs.startsWith(root + nodePath.sep)) return null;
    return abs;
  }

  /**
   * Snapshot the given workspace-relative paths NOW (before the tool runs).
   * Returns the checkpoint metadata, or null when nothing was snapshotable.
   */
  create(workspaceRoot: string, paths: string[], label: string): CheckpointMeta | null {
    this.ensureLoaded();
    const files: FileSnapshot[] = [];
    let bytes = 0;
    for (const rel of paths) {
      if (!rel || files.some((f) => f.path === rel)) continue;
      const abs = this.toAbsolute(workspaceRoot, rel);
      if (!abs) continue;
      let existed = false;
      let content = '';
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          existed = true;
          const buf = fs.readFileSync(abs);
          if (buf.length > MAX_FILE_BYTES) {
            // Too big to restore reliably — still record the path for labeling,
            // but mark content empty so restore skips it.
            files.push({ path: rel, existed: true, content: '' });
            continue;
          }
          content = buf.toString('utf-8');
        }
      } catch {
        continue;
      }
      bytes += Buffer.byteLength(content, 'utf-8');
      if (bytes > MAX_CHECKPOINT_BYTES) break;
      files.push({ path: rel, existed, content });
    }
    if (files.length === 0) return null;
    const meta: CheckpointMeta = {
      id: cryptoRandom(),
      ts: Date.now(),
      label,
      files: files.map((f) => f.path),
    };
    this.checkpoints.push({ meta, files });
    while (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();
    this.persist();
    return meta;
  }

  get(id: string): StoredCheckpoint | undefined {
    this.ensureLoaded();
    return this.checkpoints.find((c) => c.meta.id === id);
  }

  /**
   * Restore every file of a checkpoint to its pre-edit state:
   * existed → write original content back; did not exist → delete if created.
   */
  restore(workspaceRoot: string, id: string): RestoreResult {
    const found = this.get(id);
    const result: RestoreResult = { restored: 0, errors: [] };
    if (!found) {
      result.errors.push('checkpoint not found');
      return result;
    }
    for (const f of found.files) {
      const abs = this.toAbsolute(workspaceRoot, f.path);
      if (!abs) {
        result.errors.push(`${f.path}: outside workspace`);
        continue;
      }
      try {
        if (f.existed) {
          if (!f.content && fs.existsSync(abs) && fs.statSync(abs).size > 0) {
            // Oversized snapshot skipped at create-time — don't clobber.
            result.errors.push(`${f.path}: snapshot too large, skipped`);
            continue;
          }
          fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, f.content, 'utf-8');
          result.restored++;
        } else if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          result.restored++;
        }
      } catch (err) {
        result.errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The workspace changed on disk — drop checkpoints captured AFTER this
    // one (their "before" state no longer matches any reachable timeline).
    const idx = this.checkpoints.findIndex((c) => c.meta.id === id);
    if (idx >= 0) this.checkpoints = this.checkpoints.slice(0, idx);
    this.persist();
    return result;
  }

  list(): CheckpointMeta[] {
    this.ensureLoaded();
    return this.checkpoints.map((c) => c.meta);
  }
}
