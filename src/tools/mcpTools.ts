import type { ToolDefinition, McpServerConfig } from '../types';
import { schema } from '../core/toolRegistry';
import * as vscode from 'vscode';

/**
 * MCP (Model Context Protocol) client integration.
 *
 * Two transports:
 *  1. stdio — each configured server is spawned as a child process speaking
 *     JSON-RPC over stdin/stdout.
 *  2. Streamable HTTP — servers configured with a `url` (+ optional auth
 *     `headers`) speak JSON-RPC over HTTP POST, exactly like standard MCP
 *     clients that use configs such as
 *     `{ "mcpServers": { "21st": { "url": "https://21st.dev/api/mcp", "headers": {…} } } }`.
 *
 * We discover tools on first use, expose them through the registry as
 * `mcp_<server>_<tool>`, and route calls back to the server.
 */

interface DiscoveredMcpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpSession {
  config: McpServerConfig;
  transport: 'stdio' | 'http';
  /** stdio only */
  child?: import('node:child_process').ChildProcess;
  /** http only */
  url?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  tools: DiscoveredMcpTool[];
  initialized: boolean;
  buffer: string;
  /** Last stderr tail — kept for error reporting instead of being fully swallowed. */
  stderrTail: string;
}

/** Reject every pending RPC on a session (server crashed / was killed). */
function rejectAllPending(session: McpSession, reason: string): void {
  for (const [, entry] of session.pending) {
    entry.reject(new Error(reason));
  }
  session.pending.clear();
}

/** Quote a command + args into a single cmd.exe-safe string for shell:true spawns. */
function quoteWindowsCommand(command: string, args: string[]): string {
  const q = (s: string) => (/\s/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [command, ...args].map(q).join(' ');
}

export class McpManager {
  private sessions = new Map<string, McpSession>();
  private onChangeHandlers: Array<(servers: string[]) => void> = [];

  constructor() {}

  onChange(fn: (servers: string[]) => void): void {
    this.onChangeHandlers.push(fn);
  }

  private emit(): void {
    this.onChangeHandlers.forEach((fn) => fn(Array.from(this.sessions.keys())));
  }

  listConnectedServers(): string[] {
    return Array.from(this.sessions.keys());
  }

  async connect(config: McpServerConfig): Promise<DiscoveredMcpTool[]> {
    if (this.sessions.has(config.name)) {
      await this.disconnect(config.name);
    }
    // Streamable-HTTP servers (url present) never spawn a child process.
    if (config.url) {
      return this.connectHttp({ ...config, transport: 'http' });
    }
    const { spawn } = await import('node:child_process');
    // On Windows, many MCP servers are launched via .cmd shims (npx, uvx, …).
    // Node ≥ 18.20 throws EINVAL when spawning .cmd/.bat without a shell,
    // so use shell:true there. Args are joined and quoted for cmd.exe.
    const useShell = process.platform === 'win32';
    const child = useShell
      ? spawn(quoteWindowsCommand(config.command ?? '', config.args ?? []), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(config.env ?? {}) },
          shell: true,
          windowsVerbatimArguments: false,
        })
      : spawn(config.command ?? '', config.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(config.env ?? {}) },
        });

    const session: McpSession = {
      config,
      transport: 'stdio',
      child,
      nextId: 1,
      pending: new Map(),
      tools: [],
      initialized: false,
      buffer: '',
      stderrTail: '',
    };

    // CRITICAL FIX: handle spawn errors (bad command / ENOENT). Without this
    // listener, an invalid command crashes the entire extension host with an
    // unhandled 'error' event.
    child.on('error', (err) => {
      rejectAllPending(session, `MCP server "${config.name}" failed to start: ${err.message}`);
      if (this.sessions.get(config.name) === session) {
        this.sessions.delete(config.name);
        this.emit();
      }
    });

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      session.buffer += chunk;
      let idx: number;
      while ((idx = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, idx).trim();
        session.buffer = session.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMessage(session, msg);
        } catch {
          /* ignore non-JSON lines (server logs) */
        }
      }
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep only the last 4 KB of stderr for diagnostics.
      session.stderrTail = (session.stderrTail + chunk).slice(-4096);
    });

    child.on('exit', (code) => {
      // CRITICAL FIX: reject pending RPCs so callers don't hang until their
      // own 30s timers fire when a server dies mid-call.
      rejectAllPending(
        session,
        `MCP server "${config.name}" exited (code ${code ?? 'signal'}).` +
          (session.stderrTail ? ` stderr: ${session.stderrTail.trim().slice(-500)}` : '')
      );
      if (this.sessions.get(config.name) === session) {
        this.sessions.delete(config.name);
        this.emit();
      }
    });

    this.sessions.set(config.name, session);

    try {
      await this.rpc(session, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fibonacci-agent', version: '2.1.0' },
      });
      await this.rpc(session, 'notifications/initialized', {}).catch(() => {});
      const toolsResp = (await this.rpc(session, 'tools/list', {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
      };
      session.tools = (toolsResp.tools ?? []).map((t) => ({
        server: config.name,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      session.initialized = true;
      this.emit();
      return session.tools;
    } catch (err) {
      await this.disconnect(config.name);
      throw err;
    }
  }

  /** Connect to a streamable-HTTP MCP endpoint (JSON-RPC over HTTP POST). */
  private async connectHttp(config: McpServerConfig): Promise<DiscoveredMcpTool[]> {
    const session: McpSession = {
      config,
      transport: 'http',
      url: config.url!,
      headers: config.headers ?? {},
      nextId: 1,
      pending: new Map(),
      tools: [],
      initialized: false,
      buffer: '',
      stderrTail: '',
    };
    this.sessions.set(config.name, session);

    try {
      await this.rpcHttp(session, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fibonacci-agent', version: '2.1.0' },
      }).catch(async () => {
        // Older endpoints may not accept the newer protocol version.
        await this.rpcHttp(session, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'fibonacci-agent', version: '2.1.0' },
        });
      });
      await this.rpcHttp(session, 'notifications/initialized', {}, { notify: true }).catch(() => {});
      const toolsResp = (await this.rpcHttp(session, 'tools/list', {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
      };
      session.tools = (toolsResp.tools ?? []).map((t) => ({
        server: config.name,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      session.initialized = true;
      this.emit();
      return session.tools;
    } catch (err) {
      await this.disconnect(config.name);
      throw err;
    }
  }

  async disconnect(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    try {
      session.child?.kill();
    } catch {
      /* ignore */
    }
    rejectAllPending(session, `MCP server "${name}" was disconnected.`);
    this.sessions.delete(name);
    this.emit();
  }

  async disconnectAll(): Promise<void> {
    for (const name of Array.from(this.sessions.keys())) {
      await this.disconnect(name);
    }
  }

  listTools(server?: string): DiscoveredMcpTool[] {
    if (server) {
      return this.sessions.get(server)?.tools ?? [];
    }
    return Array.from(this.sessions.values()).flatMap((s) => s.tools);
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(server);
    if (!session) throw new Error(`MCP server "${server}" is not connected.`);
    if (session.transport === 'http') {
      return this.rpcHttp(session, 'tools/call', { name: tool, arguments: args });
    }
    return this.rpc(session, 'tools/call', { name: tool, arguments: args });
  }

  async callResources(server: string): Promise<unknown> {
    const session = this.sessions.get(server);
    if (!session) throw new Error(`MCP server "${server}" is not connected.`);
    if (session.transport === 'http') {
      return this.rpcHttp(session, 'resources/list', {});
    }
    return this.rpc(session, 'resources/list', {});
  }

  private handleMessage(session: McpSession, msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = session.pending.get(msg.id);
      if (entry) {
        if (msg.error) {
          entry.reject(new Error(msg.error.message ?? 'MCP error'));
        } else {
          entry.resolve(msg.result);
        }
        session.pending.delete(msg.id);
      }
    }
  }

  private rpc(session: McpSession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = session.nextId++;
      session.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      session.child?.stdin?.write(payload, (err) => {
        if (err) {
          session.pending.delete(id);
          reject(new Error(`Cannot write to MCP server: ${err.message}`));
        }
      });
      // Timeout — clear timer on resolution to prevent reference leak
      const timer = setTimeout(() => {
        if (session.pending.has(id)) {
          session.pending.delete(id);
          reject(new Error(`Timeout calling ${method} on MCP server "${session.config.name}"`));
        }
      }, 30_000);
      // Wrap resolve/reject to clear the timer on completion
      const entry = session.pending.get(id);
      if (entry) {
        session.pending.set(id, {
          resolve: (v) => { clearTimeout(timer); entry.resolve(v); },
          reject: (e) => { clearTimeout(timer); entry.reject(e); },
        });
      }
    });
  }

  /**
   * JSON-RPC over streamable HTTP.
   *
   * Sends one JSON-RPC message per POST; accepts either a plain JSON body or
   * a `text/event-stream` reply and honors the `mcp-session-id` response
   * header on subsequent calls — this is what standard MCP HTTP clients do.
   */
  private async rpcHttp(
    session: McpSession,
    method: string,
    params: unknown,
    opts: { notify?: boolean } = {}
  ): Promise<unknown> {
    const id = opts.notify ? undefined : session.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== undefined) body.id = id;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...session.headers,
        ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
      };
      const res = await fetch(session.url!, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Track the session across requests (streamable HTTP requirement).
      const sid = res.headers.get('mcp-session-id');
      if (sid) session.sessionId = sid;

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }

      if (id === undefined) return undefined; // notification — no response expected

      const contentType = res.headers.get('content-type') ?? '';
      let envelope:
        | { id?: number | string; result?: unknown; error?: { message?: string } }
        | undefined;
      if (contentType.includes('text/event-stream')) {
        envelope = parseSseRpcResponse(text, id);
      } else if (text.trim()) {
        try {
          envelope = JSON.parse(text);
        } catch {
          envelope = undefined; // e.g. 202 Accepted with empty body
        }
      }

      if (envelope && envelope.error !== undefined) {
        throw new Error(envelope.error.message ?? 'MCP error');
      }
      return envelope?.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const friendly = message.toLowerCase().includes('abort')
        ? `Timeout calling ${method} on MCP server "${session.config.name}"`
        : message;
      throw new Error(friendly);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Parse an SSE body carrying one or more JSON-RPC envelopes; pick ours by id. */
function parseSseRpcResponse(
  text: string,
  wantedId: number
): { id?: number | string; result?: unknown; error?: { message?: string } } | undefined {
  const events: Array<{ id?: number | string; result?: unknown; error?: { message?: string } }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* partial frame — ignore */
    }
  }
  return events.find((e) => e.id === wantedId) ?? events[events.length - 1];
}

// ---- Tool definitions surfaced to the LLM ----

export const mcpToolDefinitions: ToolDefinition[] = [
  {
    name: 'list_mcp_tools',
    category: 'mcp',
    description: 'List available tools on an MCP server (or all servers if no name is given).',
    parameters: schema(
      { server: { type: 'string', description: 'Server name (optional; if omitted, all servers)' } }
    ),
    requiresApproval: false,
    readOnly: true,
  },
  {
    name: 'call_mcp_tool',
    category: 'mcp',
    description: 'Call a tool on an MCP server.',
    parameters: schema(
      {
        server: { type: 'string', description: 'MCP server name' },
        tool: { type: 'string', description: 'Tool name' },
        args: { type: 'object', description: 'Tool arguments (as JSON)', additionalProperties: true },
      },
      ['server', 'tool']
    ),
    requiresApproval: true,
  },
  {
    name: 'get_mcp_resources',
    category: 'mcp',
    description: 'List resources available on an MCP server.',
    parameters: schema(
      { server: { type: 'string', description: 'MCP server name' } },
      ['server']
    ),
    requiresApproval: false,
    readOnly: true,
  },
  {
    name: 'manage_mcp_servers',
    category: 'mcp',
    description: 'Add/remove/connect/disconnect MCP servers. action: list | add | remove | connect | disconnect.',
    parameters: schema(
      {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'connect', 'disconnect'] },
        server: { type: 'object', description: 'Server config (only for add/connect)' },
        name: { type: 'string', description: 'Server name (for remove/disconnect)' },
      },
      ['action']
    ),
    requiresApproval: true,
  },
];

export function registerMcpTools(
  registry: import('../core/toolRegistry').ToolRegistry,
  manager: McpManager,
  context: { onServersChanged: (servers: McpServerConfig[]) => void }
): void {
  // FIX (enableMCP required restart): the tools are registered unconditionally
  // and gated here at runtime, so toggling the setting takes effect
  // immediately. `cfg.get` returns the package.json default (true) when the
  // user never touched the setting — only an explicit `false` disables.
  const isMcpDisabled = (): boolean =>
    vscode.workspace.getConfiguration('fibonacci').get<boolean>('enableMCP') === false;
  const disabledOutput = (): { ok: boolean; output: string } => ({
    ok: false,
    output:
      'MCP integration is disabled in settings (fibonacci.enableMCP). Enable it (no restart needed) and retry.',
  });

  registry.register(mcpToolDefinitions[0], async (args) => {
    if (isMcpDisabled()) return disabledOutput();
    const tools = manager.listTools(args.server ? String(args.server) : undefined);
    if (tools.length === 0) {
      return { ok: true, output: '(No MCP tools found. Connect a server first.)' };
    }
    const lines = tools.map(
      (t) => `${t.server}/${t.name}${t.description ? ` — ${t.description}` : ''}`
    );
    return { ok: true, output: lines.join('\n') };
  });

  registry.register(mcpToolDefinitions[1], async (args) => {
    if (isMcpDisabled()) return disabledOutput();
    const result = await manager.callTool(
      String(args.server),
      String(args.tool),
      (args.args as Record<string, unknown>) ?? {}
    );
    return { ok: true, output: JSON.stringify(result, null, 2).slice(0, 8000) };
  });

  registry.register(mcpToolDefinitions[2], async (args) => {
    if (isMcpDisabled()) return disabledOutput();
    // Resources aren't supported by all servers — best effort.
    try {
      const resp = await manager.callResources(String(args.server));
      return { ok: true, output: JSON.stringify(resp, null, 2) };
    } catch (err) {
      return { ok: false, output: `Server does not support resources: ${(err as Error).message}` };
    }
  });

  registry.register(mcpToolDefinitions[3], async (args) => {
    if (isMcpDisabled()) return disabledOutput();
    const action = String(args.action);
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    const servers = (cfg.get<McpServerConfig[]>('mcpServers') ?? []).slice();
    switch (action) {
      case 'list': {
        const connected = manager.listConnectedServers();
        return {
          ok: true,
          output: servers
            .map(
              (s) =>
                `${s.name}: ${s.url ? `${s.url} [HTTP]` : `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()} [${connected.includes(s.name) ? 'connected' : 'disconnected'}]`
            )
            .join('\n') || '(no servers configured)',
        };
      }
      case 'add': {
        const server = args.server as McpServerConfig;
        if (!server?.name || (!server?.url && !server?.command)) {
          return { ok: false, output: 'Either "url" (HTTP server) or "command" (stdio server) plus a name is required.' };
        }
        if (servers.find((s) => s.name === server.name)) {
          return { ok: false, output: `Server "${server.name}" already exists.` };
        }
        servers.push(server);
        await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
        context.onServersChanged(servers);
        return { ok: true, output: `Server "${server.name}" added.` };
      }
      case 'remove': {
        const name = String(args.name);
        const next = servers.filter((s) => s.name !== name);
        await cfg.update('mcpServers', next, vscode.ConfigurationTarget.Global);
        await manager.disconnect(name);
        context.onServersChanged(next);
        return { ok: true, output: `Server "${name}" removed.` };
      }
      case 'connect': {
        const server = args.server as McpServerConfig;
        if (!server?.name || (!server?.url && !server?.command)) {
          return { ok: false, output: 'A name plus "url" or "command" is required.' };
        }
        const tools = await manager.connect(server);
        return { ok: true, output: `Server "${server.name}" connected with ${tools.length} tools.` };
      }
      case 'disconnect': {
        await manager.disconnect(String(args.name));
        return { ok: true, output: `Server "${args.name}" disconnected.` };
      }
      default:
        return { ok: false, output: `Invalid action: ${action}` };
    }
  });
}
