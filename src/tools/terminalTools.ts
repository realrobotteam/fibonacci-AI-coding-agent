import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';

/**
 * Terminal tools:
 *  - execute_command: run, capture stdout/stderr, return output
 *  - run_in_terminal: send to the integrated terminal (visible to user)
 *  - get_command_output: peek at recent output of a tracked terminal
 *
 * All execute_command calls require user approval (side effects are external).
 */

interface RunningTerminal {
  name: string;
  terminal: vscode.Terminal;
  startedAt: number;
  lastOutput: string;
}

const runningTerminals = new Map<string, RunningTerminal>();

/**
 * CRITICAL FIX (bug T1/T2): Resolve a valid working directory.
 *
 * The previous version used `defaultCwd` captured at activation time, which
 * could go stale if the user opened/closed folders. It also never validated
 * that the directory exists. On Windows, `child_process.exec` with a
 * non-existent cwd throws a misleading error:
 *   "spawn C:\WINDOWS\system32\cmd.exe ENOENT"
 * (The error names cmd.exe, but the real culprit is the missing cwd.)
 *
 * This function:
 *   1. Re-resolves the workspace root at call time (not activation time)
 *   2. Validates that the cwd exists and is a directory
 *   3. Falls back to os.homedir() if all else fails
 */
function resolveValidCwd(cwdArg: unknown): string {
  // If the caller provided a cwd, validate it.
  if (typeof cwdArg === 'string' && cwdArg.length > 0) {
    try {
      const stat = fsSync.statSync(cwdArg);
      if (stat.isDirectory()) return cwdArg;
    } catch {
      // doesn't exist — fall through
    }
  }

  // Try the VS Code workspace folder.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    try {
      const stat = fsSync.statSync(folder);
      if (stat.isDirectory()) return folder;
    } catch {
      // fall through
    }
  }

  // Fall back to ~/Documents/fibonacci-agent, then homedir.
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fsSync.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fsSync.existsSync(fallbackDir)) {
    try { fsSync.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
  }
  if (fsSync.existsSync(fallbackDir)) return fallbackDir;
  return home;
}

/**
 * CRITICAL FIX (bug T2): Resolve the shell to use for exec().
 *
 * On Windows, `child_process.exec` uses `process.env.ComSpec` (defaults to
 * cmd.exe). But the VS Code extension host process may not inherit ComSpec
 * properly, causing "spawn cmd.exe ENOENT". We explicitly resolve the shell.
 */
function resolveShell(): string {
  if (process.platform === 'win32') {
    // Try ComSpec first (usually C:\WINDOWS\system32\cmd.exe)
    const comSpec = process.env.ComSpec;
    if (comSpec && fsSync.existsSync(comSpec)) return comSpec;
    // Try common Windows shell locations
    const systemRoot = process.env.SystemRoot ?? 'C:\\WINDOWS';
    const cmdPath = path.join(systemRoot, 'system32', 'cmd.exe');
    if (fsSync.existsSync(cmdPath)) return cmdPath;
    // Last resort: just 'cmd.exe' and hope PATH has it
    return 'cmd.exe';
  }
  // Unix: try SHELL, then fall back to /bin/bash, then /bin/sh
  const shell = process.env.SHELL;
  if (shell && fsSync.existsSync(shell)) return shell;
  if (fsSync.existsSync('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

export const terminalToolDefinitions: ToolDefinition[] = [
  {
    name: 'execute_command',
    category: 'terminal',
    description:
      'Run a shell command and return its output (stdout + stderr). Requires user approval. timeout is in milliseconds (default: 60000).',
    parameters: schema(
      {
        command: { type: 'string', description: 'Command to run' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 60000)' },
      },
      ['command']
    ),
    requiresApproval: true,
  },
  {
    name: 'run_in_terminal',
    category: 'terminal',
    description: 'Run a command in the integrated VS Code terminal (visible to the user). Suitable for long-running tasks like dev servers.',
    parameters: schema(
      {
        command: { type: 'string', description: 'Command to run' },
        name: { type: 'string', description: 'Terminal name (optional)' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      ['command']
    ),
    requiresApproval: true,
  },
  {
    name: 'get_command_output',
    category: 'terminal',
    description: 'Return the latest output of a running terminal.',
    parameters: schema(
      {
        name: { type: 'string', description: 'Terminal name' },
      },
      ['name']
    ),
    requiresApproval: false,
    readOnly: true,
  },
];

export function registerTerminalTools(
  registry: import('../core/toolRegistry').ToolRegistry,
  _defaultCwd: string
): void {
  registry.register(terminalToolDefinitions[0], async (args) => {
    // CRITICAL FIX (bug T4): Validate command before executing.
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      return { ok: false, output: 'Error: "command" parameter is missing or empty.' };
    }
    const command = String(args.command);
    // CRITICAL FIX (bug T1): Re-resolve and validate cwd at call time.
    const cwd = resolveValidCwd(args.cwd);
    const timeout = Number(args.timeout ?? 60_000);

    // Use child_process for output capture (VS Code Terminal API doesn't expose stdout).
    const { exec } = await import('node:child_process');
    // CRITICAL FIX (bug T2): Pass an explicit shell to avoid ENOENT.
    const shell = resolveShell();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      const child = exec(command, { cwd, shell, maxBuffer: 10 * 1024 * 1024, timeout });
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(-20_000);
        resolve({
          ok: code === 0,
          output: `Exit code: ${code}\n${out || '(no output)'}`,
          meta: { code },
        });
      });
      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        // CRITICAL FIX (bug T1): Provide a helpful error message that
        // explains the real cause (cwd or shell issue, not cmd.exe itself).
        const errMsg = err.message;
        let helpful = `Execution error: ${errMsg}`;
        if (errMsg.includes('ENOENT')) {
          helpful += `\n\nThis usually means the working directory "${cwd}" doesn't exist, or the shell "${shell}" couldn't be found. ` +
            `Try using an absolute path for the working directory, or ensure the command is valid.`;
        }
        resolve({ ok: false, output: helpful });
      });
    });
  });

  registry.register(terminalToolDefinitions[1], async (args) => {
    // CRITICAL FIX (bug T4): Validate command.
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      return { ok: false, output: 'Error: "command" parameter is missing or empty.' };
    }
    const command = String(args.command);
    const name = String(args.name ?? 'fibonacci');
    // CRITICAL FIX (bug T1): Validate cwd.
    const cwd = resolveValidCwd(args.cwd);
    const terminal = vscode.window.createTerminal({ name, cwd });
    runningTerminals.set(name, { name, terminal, startedAt: Date.now(), lastOutput: '' });
    terminal.show(true);
    terminal.sendText(command);
    return { ok: true, output: `Command started in terminal "${name}".` };
  });

  registry.register(terminalToolDefinitions[2], async (args) => {
    const name = String(args.name);
    const entry = runningTerminals.get(name);
    if (!entry) {
      return { ok: false, output: `Terminal "${name}" not found.` };
    }
    // VS Code doesn't expose terminal stdout; this is a best-effort placeholder.
    return {
      ok: true,
      output:
        entry.lastOutput ||
        '(VS Code Terminal API does not allow reading stdout directly. Use execute_command to capture output.)',
    };
  });
}
