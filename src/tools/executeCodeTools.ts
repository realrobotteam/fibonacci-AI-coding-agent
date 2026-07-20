import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * execute_code tool — run a Python or JavaScript script that calls tools
 * programmatically, collapsing multi-step pipelines into a single turn.
 *
 * Inspired by Hermes Agent's `execute_code`. The script gets a `tools` object
 * injected (via a helper module) that exposes the agent's registered tools
 * as async functions. stdout/stderr are returned to the model.
 *
 * Supported languages:
 *   - python3 (default; uses python3 from PATH)
 *   - node (JavaScript)
 *
 * Hard limits: 5-minute timeout, 50KB stdout cap, 50 tool calls per script.
 */

const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDOUT = 50_000;
const MAX_TOOL_CALLS = 50;

export const executeCodeToolDefinitions: ToolDefinition[] = [
  {
    name: 'execute_code',
    category: 'meta',
    description:
      'Run a Python or JavaScript script that calls the agent\'s tools programmatically via a `tools` helper. Collapses multi-step pipelines (e.g. "read N files, search each, write summary") into a single turn. Languages: python3 (default), node. Hard limits: 5-min timeout, 50KB stdout cap, 50 tool calls per script. Use this when you need to repeat the same operation across many inputs — much cheaper than calling the tool N times individually.',
    parameters: schema(
      {
        language: {
          type: 'string',
          enum: ['python3', 'node'],
          description: 'Script language (default: python3)',
        },
        script: {
          type: 'string',
          description: 'The script source code. In Python: import `tools` and call `await tools.read_file(path="...")`. In Node: `const tools = require("./tools"); await tools.read_file({path: "..."})`.',
        },
        timeout: {
          type: 'number',
          description: `Timeout in ms (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS})`,
        },
      },
      ['script']
    ),
    requiresApproval: true,
    readOnly: false,
    tags: ['code', 'execution'],
  },
];

interface ExecuteCodeDeps {
  registry: ToolRegistry;
  workspaceRoot: string;
  /** Optional: VS Code ExtensionContext for storage (unused now, future). */
  context?: vscode.ExtensionContext;
}

export function registerExecuteCodeTools(
  registry: ToolRegistry,
  deps: ExecuteCodeDeps
): void {
  registry.register(executeCodeToolDefinitions[0], async (args, ctx) => {
    const language = (args.language as string) ?? 'python3';
    const script = String(args.script ?? '');
    const timeout = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(5_000, Number(args.timeout ?? DEFAULT_TIMEOUT_MS))
    );

    if (!script.trim()) {
      return { ok: false, output: 'No script provided.' };
    }

    // Set up a temp directory with the script + a tools helper module.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fibonacci-exec-'));
    let toolCallCount = 0;
    const toolCallLog: string[] = [];

    try {
      // Build the tools helper module. It exposes every registered tool as an
      // async function taking a single args object. Each call increments the
      // counter and aborts if we exceed MAX_TOOL_CALLS.
      const toolList = deps.registry.list();
      const toolNames = toolList.map((t) => t.name);

      // The helper module is shared between Python and Node (we generate both).
      const pythonHelper = buildPythonHelper(toolNames);
      const nodeHelper = buildNodeHelper(toolNames);

      fs.writeFileSync(path.join(tmpDir, 'tools.py'), pythonHelper, 'utf-8');
      fs.writeFileSync(path.join(tmpDir, 'tools.js'), nodeHelper, 'utf-8');

      // The bridge: a JSON-lines protocol over stdin/stdout. The script calls
      // tools via the helper, which writes a JSON request to stdout; the host
      // reads it, executes the tool, and writes the JSON response to stdin.
      // To keep this simple and robust, we instead inline-execute tool calls
      // by having the helper write each call to a queue file and the host
      // process them. But the simplest approach is: the helper POSTs each
      // call to a localhost HTTP endpoint that the host spins up. That's too
      // heavy for an extension host.
      //
      // Simpler approach: we pre-execute by scanning the script for tool
      // calls is too fragile. Instead, we use a different pattern: the
      // script is augmented with a tools module that uses Node's
      // `process.send` (IPC) if running under node, or a subprocess pipe
      // for python. To keep this manageable, we use a JSON-RPC over stdin/
      // stdout protocol where the SCRIPT is the server and the HOST is the
      // client — wait, that's backwards.
      //
      // ACTUAL simplest approach: the host writes the tool registry's
      // results to a pre-computed JSON file that the script can read. But
      // that requires knowing the calls ahead of time.
      //
      // REAL approach used here: the helper module writes each tool call as
      // a JSON line to a "calls.jsonl" file. After the script finishes, the
      // host reads the calls file, executes them in order, writes the
      // results to "results.jsonl", then re-runs the script with the
      // results available. This is a 2-pass approach.
      //
      // To keep this tractable for a v1, we use a DIFFERENT simpler pattern:
      // the helper module makes HTTP requests to a temporary local server
      // that the host runs in-process. This is the standard approach used
      // by Jupyter kernels and similar.
      //
      // For v1, we use the simplest thing that works: synchronous stdin/
      // stdout JSON-RPC. The script's helper writes a request line to stdout
      // (with a special prefix `__TOOL_CALL__:`), the host reads stdout,
      // executes the tool, and writes the response to stdin. The helper
      // blocks on stdin read until the response arrives.

      // Build the script wrapper that sets up the IPC bridge.
      const isPython = language !== 'node';
      const scriptFile = isPython ? 'script.py' : 'script.js';
      const fullScript = isPython
        ? buildPythonWrapper(script)
        : buildNodeWrapper(script);
      fs.writeFileSync(path.join(tmpDir, scriptFile), fullScript, 'utf-8');

      // Run the script with a stdin/stdout JSON-RPC bridge.
      const result = await runScriptWithBridge({
        language,
        scriptPath: path.join(tmpDir, scriptFile),
        cwd: deps.workspaceRoot,
        timeout,
        registry: deps.registry,
        toolCallCounter: () => toolCallCount,
        incrementToolCall: () => { toolCallCount++; },
        addToolCallLog: (entry: string) => toolCallLog.push(entry),
        signal: ctx?.signal,
      });

      const summary = `[execute_code ${language} — exit ${result.exitCode}, ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}, ${result.duration}ms]\n\n--- stdout ---\n${result.stdout.slice(0, MAX_STDOUT)}${result.stdout.length > MAX_STDOUT ? '\n[...truncated...]' : ''}${result.stderr ? `\n\n--- stderr ---\n${result.stderr.slice(0, MAX_STDOUT)}` : ''}${toolCallLog.length > 0 ? `\n\n--- tool calls ---\n${toolCallLog.join('\n')}` : ''}`;

      return {
        ok: result.exitCode === 0,
        output: summary,
        meta: {
          exitCode: result.exitCode,
          toolCalls: toolCallCount,
          duration: result.duration,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `execute_code failed: ${msg}` };
    } finally {
      // Clean up temp dir
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge runner — runs the script as a child process and proxies tool calls
// over stdin/stdout using a JSON-RPC-like line protocol.
// ─────────────────────────────────────────────────────────────────────────────

interface BridgeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

async function runScriptWithBridge(opts: {
  language: string;
  scriptPath: string;
  cwd: string;
  timeout: number;
  registry: ToolRegistry;
  toolCallCounter: () => number;
  incrementToolCall: () => void;
  addToolCallLog: (entry: string) => void;
  signal?: AbortSignal;
}): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const cmd = opts.language === 'node' ? 'node' : 'python3';
    const args = [opts.scriptPath];

    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeout,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let stdout = '';
    let stderr = '';

    // We need bidirectional IPC. execFile doesn't easily expose stdin writes
    // in a promisified way, so we use spawn for finer control.
    child.stdin?.setDefaultEncoding('utf-8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      // Process line by line. Lines starting with `__TOOL_CALL__:` are tool
      // call requests; everything else is regular stdout.
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('__TOOL_CALL__:')) {
          // Parse the JSON request
          const jsonStr = line.slice('__TOOL_CALL__:'.length).trim();
          try {
            const req = JSON.parse(jsonStr) as { id: number; name: string; args: Record<string, unknown> };
            // Execute the tool asynchronously
            handleToolCall(req).catch((err) => {
              console.error('[fibonacci-agent] Unhandled tool call error in execute_code:', err);
            });
          } catch (err) {
            // Malformed — log to stderr
            child.stdin?.write(JSON.stringify({ error: `malformed tool call: ${err instanceof Error ? err.message : String(err)}` }) + '\n');
          }
        } else if (line.length > 0) {
          stdout += line + '\n';
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    async function handleToolCall(req: { id: number; name: string; args: Record<string, unknown> }): Promise<void> {
      if (opts.toolCallCounter() >= MAX_TOOL_CALLS) {
        child.stdin?.write(JSON.stringify({ id: req.id, error: `tool call limit (${MAX_TOOL_CALLS}) exceeded` }) + '\n');
        return;
      }
      opts.incrementToolCall();
      const logEntry = `#${req.id} ${req.name}(${JSON.stringify(req.args).slice(0, 100)})`;
      opts.addToolCallLog(logEntry);
      try {
        const result = await opts.registry.execute(req.name, req.args, {
          workspaceRoot: opts.cwd,
          log: () => {},
          signal: opts.signal,
        });
        child.stdin?.write(JSON.stringify({ id: req.id, result }) + '\n');
      } catch (err) {
        child.stdin?.write(JSON.stringify({ id: req.id, error: err instanceof Error ? err.message : String(err) }) + '\n');
      }
    }

    const cleanup = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    };

    opts.signal?.addEventListener('abort', cleanup);
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, opts.timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cleanup);
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', cleanup);
      resolve({
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: (stderr + '\n' + err.message).trim(),
        duration: Date.now() - startTime,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Script wrappers — inject the tools helper and the user's script.
// ─────────────────────────────────────────────────────────────────────────────

function buildPythonHelper(toolNames: string[]): string {
  const functions = toolNames
    .map(
      (name) => `
async def ${name.replace(/[^a-zA-Z0-9_]/g, '_')}(**kwargs):
    return await _call_tool(${JSON.stringify(name)}, kwargs)`
    )
    .join('\n');
  return `# Auto-generated tools helper for Fibonacci Agent execute_code.
import sys, json, asyncio, threading

def _call_tool_sync(name, args):
    """Write a tool call request to stdout, read the response from stdin."""
    req_id = _next_id()
    line = "__TOOL_CALL__:" + json.dumps({"id": req_id, "name": name, "args": args}) + "\\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    # Read the response line from stdin
    resp_line = sys.stdin.readline()
    if not resp_line:
        raise RuntimeError(f"no response from host for tool {name}")
    try:
        resp = json.loads(resp_line)
    except Exception as e:
        raise RuntimeError(f"malformed response for {name}: {resp_line!r}: {e}")
    if "error" in resp:
        raise RuntimeError(f"tool {name} error: {resp['error']}")
    return resp.get("result")

_id_counter = [0]
def _next_id():
    _id_counter[0] += 1
    return _id_counter[0]

async def _call_tool(name, args):
    """Async wrapper — runs the sync call in a thread."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _call_tool_sync, name, args)

# Exposed tool functions:
${functions}
`;
}

function buildNodeHelper(toolNames: string[]): string {
  return `// Auto-generated tools helper for Fibonacci Agent execute_code.
const readline = require('readline');

let _nextId = 1;
const _pending = new Map();

const _rl = readline.createInterface({ input: process.stdin, terminal: false });
_rl.on('line', (line) => {
  try {
    const resp = JSON.parse(line);
    const entry = _pending.get(resp.id);
    if (entry) {
      _pending.delete(resp.id);
      if (resp.error) entry.reject(new Error(resp.error));
      else entry.resolve(resp.result);
    }
  } catch (e) {
    // ignore malformed lines
  }
});

function _callToolSync(name, args) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    process.stdout.write('__TOOL_CALL__:' + JSON.stringify({ id, name, args }) + '\\n');
  });
}

async function _callTool(name, args) {
  return await _callToolSync(name, args);
}

module.exports = {
  _callTool,
${toolNames.map((n) => {
  const safeName = n.replace(/[^a-zA-Z0-9_]/g, '_');
  return `  ${safeName}: async (args = {}) => _callTool(${JSON.stringify(n)}, args),`;
}).join('\n')}
};
`;
}

function buildPythonWrapper(userScript: string): string {
  return `import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tools import *
import asyncio

async def _main():
${userScript
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n')}

asyncio.run(_main())
`;
}

function buildNodeWrapper(userScript: string): string {
  return `const tools = require('./tools');
const path = require('path');

async function main() {
${userScript
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n')}
}

main().catch((e) => { console.error(e); process.exit(1); });
`;
}
