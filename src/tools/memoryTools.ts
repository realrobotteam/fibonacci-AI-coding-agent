import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * Memory tool — persistent cross-session declarative facts.
 *
 * Inspired by Hermes Agent's `memory` tool. Stores facts in a JSON file under
 * the VS Code globalStorage directory. Facts are user-scoped (about the user,
 * their preferences, their project) — NOT procedural (procedures go in skills)
 * and NOT task-state (that's the todo list).
 *
 * Supports atomic batch operations: set, delete, append (to a list), clear.
 * Returns the post-operation memory snapshot so the model can verify.
 */

interface MemoryEntry {
  key: string;
  value: unknown;
  ts: number;
  tags?: string[];
}

interface MemoryStore {
  entries: Record<string, MemoryEntry>;
}

const STORAGE_FILE = 'memory.json';

function getStoragePath(context?: vscode.ExtensionContext): string {
  // Prefer VS Code globalStorageUri if available (persists across sessions,
  // survives extension unloads). Fall back to ~/.fibonacci-agent/memory.json.
  if (context && context.globalStorageUri) {
    return path.join(context.globalStorageUri.fsPath, STORAGE_FILE);
  }
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return path.join(home, '.fibonacci-agent', STORAGE_FILE);
}

class MemoryManager {
  private store: MemoryStore = { entries: {} };
  private loaded = false;
  private storagePath: string;

  constructor(context?: vscode.ExtensionContext) {
    this.storagePath = getStoragePath(context);
  }

  private load(): void {
    if (this.loaded) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        this.store = JSON.parse(raw) as MemoryStore;
        if (!this.store.entries) this.store.entries = {};
      }
    } catch (err) {
      console.error('[fibonacci-agent] memory load failed:', err);
      this.store = { entries: {} };
    }
    this.loaded = true;
  }

  private save(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (err) {
      console.error('[fibonacci-agent] memory save failed:', err);
    }
  }

  get(key: string): MemoryEntry | undefined {
    this.load();
    return this.store.entries[key];
  }

  list(): MemoryEntry[] {
    this.load();
    return Object.values(this.store.entries).sort((a, b) => b.ts - a.ts);
  }

  set(key: string, value: unknown, tags?: string[]): MemoryEntry {
    this.load();
    const entry: MemoryEntry = { key, value, ts: Date.now(), tags };
    this.store.entries[key] = entry;
    this.save();
    return entry;
  }

  delete(key: string): boolean {
    this.load();
    const existed = !!this.store.entries[key];
    delete this.store.entries[key];
    if (existed) this.save();
    return existed;
  }

  append(key: string, value: unknown): MemoryEntry {
    this.load();
    const existing = this.store.entries[key];
    const arr = Array.isArray(existing?.value) ? [...(existing!.value as unknown[])] : [];
    arr.push(value);
    return this.set(key, arr);
  }

  clear(): number {
    this.load();
    const count = Object.keys(this.store.entries).length;
    this.store.entries = {};
    this.save();
    return count;
  }

  snapshot(): MemoryStore {
    this.load();
    return JSON.parse(JSON.stringify(this.store));
  }
}

let manager: MemoryManager | null = null;

export function initMemoryManager(context?: vscode.ExtensionContext): MemoryManager {
  if (!manager) {
    manager = new MemoryManager(context);
  }
  return manager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

export const memoryToolDefinitions: ToolDefinition[] = [
  {
    name: 'memory',
    category: 'meta',
    description:
      'Persistent cross-session memory for declarative facts about the user, their preferences, and their projects. NOT for procedures (use skills) and NOT for task-state (use update_todos). Supports batch atomic operations: set, get, delete, append (to a list), list, clear. Memory persists across VS Code restarts.',
    parameters: schema(
      {
        operations: {
          type: 'array',
          description: 'Batch of operations to apply atomically. Each: { op: "set"|"get"|"delete"|"append"|"list"|"clear", key, value?, tags? }',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['set', 'get', 'delete', 'append', 'list', 'clear'],
                description: 'Operation type',
              },
              key: {
                type: 'string',
                description: 'Memory key (e.g. "user.preferred_language", "project.fibonacci.tech_stack")',
              },
              value: {
                description: 'Value to set/append (any JSON type: string, number, boolean, object, array)',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags for grouping/filtering',
              },
            },
            required: ['op'],
          },
        },
      },
      ['operations']
    ),
    requiresApproval: false,
    readOnly: false,
    tags: ['memory', 'persistent'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerMemoryTools(registry: ToolRegistry): void {
  const mgr = initMemoryManager();

  registry.register(memoryToolDefinitions[0], async (args) => {
    const ops = (args.operations as Array<Record<string, unknown>>) ?? [];
    if (ops.length === 0) {
      return { ok: false, output: 'No operations provided. Pass an operations array.' };
    }
    if (ops.length > 50) {
      return { ok: false, output: 'Too many operations (max 50 per call).' };
    }

    const results: string[] = [];
    for (const op of ops) {
      const kind = String(op.op ?? '');
      const key = op.key ? String(op.key) : '';
      switch (kind) {
        case 'set': {
          if (!key) {
            results.push(`set: ERROR — key required`);
            break;
          }
          mgr.set(key, op.value, op.tags as string[] | undefined);
          results.push(`set: ${key} = ${formatValue(op.value)}`);
          break;
        }
        case 'get': {
          if (!key) {
            results.push(`get: ERROR — key required`);
            break;
          }
          const entry = mgr.get(key);
          results.push(entry ? `get: ${key} = ${formatValue(entry.value)}` : `get: ${key} = (undefined)`);
          break;
        }
        case 'delete': {
          if (!key) {
            results.push(`delete: ERROR — key required`);
            break;
          }
          const existed = mgr.delete(key);
          results.push(`delete: ${key} ${existed ? 'deleted' : '(not found)'}`);
          break;
        }
        case 'append': {
          if (!key) {
            results.push(`append: ERROR — key required`);
            break;
          }
          const entry = mgr.append(key, op.value);
          results.push(`append: ${key} now has ${(entry.value as unknown[]).length} item(s)`);
          break;
        }
        case 'list': {
          const entries = mgr.list();
          results.push(`list: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
          for (const e of entries.slice(0, 20)) {
            results.push(`  - ${e.key} = ${formatValue(e.value).slice(0, 80)}`);
          }
          if (entries.length > 20) results.push(`  ... (${entries.length - 20} more)`);
          break;
        }
        case 'clear': {
          const count = mgr.clear();
          results.push(`clear: removed ${count} entr${count === 1 ? 'y' : 'ies'}`);
          break;
        }
        default:
          results.push(`UNKNOWN OP: ${kind}`);
      }
    }

    const snapshot = mgr.list();
    const summary = `[memory: ${snapshot.length} total entr${snapshot.length === 1 ? 'y' : 'ies'} after ${ops.length} operation${ops.length === 1 ? '' : 's'}]\n${results.join('\n')}`;
    return { ok: true, output: summary, meta: { totalEntries: snapshot.length } };
  });
}

function formatValue(v: unknown): string {
  if (v === undefined) return '(undefined)';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
