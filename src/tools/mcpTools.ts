import type { ToolDefinition, McpServerConfig } from '../types';
import { schema } from '../core/toolRegistry';
import * as vscode from 'vscode';

/**
 * MCP (Model Context Protocol) client integration.
 *
 * Each configured MCP server is spawned as a child process speaking JSON-RPC
 * over stdio. We discover its tools on first use, expose them through the
 * registry as `mcp_<server>_<tool>`, and route calls back to the server.
 */

interface DiscoveredMcpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpSession {
  config: McpServerConfig;
  child: import('node:child_process').ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  tools: DiscoveredMcpTool[];
  initialized: boolean;
  buffer: string;
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
    const { spawn } = await import('node:child_process');
    const child = spawn(config.command, config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(config.env ?? {}) },
    });

    const session: McpSession = {
      config,
      child,
      nextId: 1,
      pending: new Map(),
      tools: [],
      initialized: false,
      buffer: '',
    };

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

    child.stderr?.on('data', () => {
      /* swallow stderr — MCP servers can be chatty */
    });

    child.on('exit', () => {
      this.sessions.delete(config.name);
      this.emit();
    });

    this.sessions.set(config.name, session);

    try {
      await this.rpc(session, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fibonacci-agent', version: '0.1.0' },
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

  async disconnect(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;
    try {
      session.child.kill();
    } catch {
      /* ignore */
    }
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
    return this.rpc(session, 'tools/call', { name: tool, arguments: args });
  }

  async callResources(server: string): Promise<unknown> {
    const session = this.sessions.get(server);
    if (!session) throw new Error(`MCP server "${server}" is not connected.`);
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
      session.child.stdin?.write(payload, (err) => {
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
  registry.register(mcpToolDefinitions[0], async (args) => {
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
    const result = await manager.callTool(
      String(args.server),
      String(args.tool),
      (args.args as Record<string, unknown>) ?? {}
    );
    return { ok: true, output: JSON.stringify(result, null, 2).slice(0, 8000) };
  });

  registry.register(mcpToolDefinitions[2], async (args) => {
    // Resources aren't supported by all servers — best effort.
    try {
      const resp = await manager.callResources(String(args.server));
      return { ok: true, output: JSON.stringify(resp, null, 2) };
    } catch (err) {
      return { ok: false, output: `Server does not support resources: ${(err as Error).message}` };
    }
  });

  registry.register(mcpToolDefinitions[3], async (args) => {
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
                `${s.name}: ${s.command} ${(s.args ?? []).join(' ')} [${connected.includes(s.name) ? 'connected' : 'disconnected'}]`
            )
            .join('\n') || '(no servers configured)',
        };
      }
      case 'add': {
        const server = args.server as McpServerConfig;
        if (!server?.name || !server?.command) {
          return { ok: false, output: 'Server name and command are required.' };
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
