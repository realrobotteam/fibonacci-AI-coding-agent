import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import * as vscode from 'vscode';

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
  defaultCwd: string
): void {
  registry.register(terminalToolDefinitions[0], async (args) => {
    const command = String(args.command);
    const cwd = String(args.cwd ?? defaultCwd);
    const timeout = Number(args.timeout ?? 60_000);
    const terminal = vscode.window.createTerminal({
      name: 'fibonacci-cmd',
      cwd,
    });
    terminal.show(true);
    // Use child_process for output capture (VS Code Terminal API doesn't expose stdout).
    const { exec } = await import('node:child_process');
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = exec(command, { cwd, maxBuffer: 10 * 1024 * 1024, timeout });
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        terminal.dispose();
        const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(-20_000);
        resolve({
          ok: code === 0,
          output: `Exit code: ${code}\n${out || '(no output)'}`,
          meta: { code },
        });
      });
      child.on('error', (err) => {
        resolve({ ok: false, output: `Execution error: ${err.message}` });
      });
    });
  });

  registry.register(terminalToolDefinitions[1], async (args) => {
    const command = String(args.command);
    const name = String(args.name ?? 'fibonacci');
    const cwd = String(args.cwd ?? defaultCwd);
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
