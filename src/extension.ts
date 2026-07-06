import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { FibonacciClient } from './api/fibonacciClient';
import { ToolRegistry } from './core/toolRegistry';
import { ApprovalManager } from './core/approvalManager';
import { registerFileTools } from './tools/fileTools';
import { registerTerminalTools } from './tools/terminalTools';
import { McpManager, registerMcpTools } from './tools/mcpTools';
import { registerTodoTool } from './tools/todoTools';
import { registerActiveEditorTools } from './tools/activeEditorTools';
import { FibonacciAgentViewProvider } from './webviewProvider';
import type { AgentConfig, McpServerConfig, ModelChoice } from './types';

/**
 * Determine the workspace root. If the user has a folder open in VS Code,
 * use that. Otherwise, fall back to ~/Documents/fibonacci-agent (created
 * automatically) instead of process.cwd() which would point to the VS Code
 * installation directory on Windows.
 */
function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    return folder;
  }
  // No folder open — use ~/Documents/fibonacci-agent (or ~/fibonacci-agent on
  // platforms where Documents doesn't exist).
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
      console.log(`[fibonacci-agent] Created fallback workspace: ${fallbackDir}`);
    } catch (err) {
      console.error('[fibonacci-agent] Failed to create fallback dir:', err);
    }
  }
  return fallbackDir;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[fibonacci-agent] activate() called');
  const workspaceRoot = getWorkspaceRoot();

  // Notify the user once if we're using the fallback (no folder open).
  if (!vscode.workspace.workspaceFolders?.[0]) {
    vscode.window.showInformationMessage(
      `Fibonacci: چون پوشه‌ای باز نیست، فایل‌ها در «${workspaceRoot}» ذخیره می‌شوند. برای تغییر، یک پوشه در VS Code باز کنید.`
    );
  }

  // --- Core services ---
  const client = new FibonacciClient();
  const registry = new ToolRegistry();
  const approvals = new ApprovalManager(
    registry,
    vscode.workspace.getConfiguration('fibonacci').get<boolean>('autoApproveReadOnly') ?? true
  );
  const mcpManager = new McpManager();

  // --- Register tools ---
  registerFileTools(registry, workspaceRoot);
  registerTerminalTools(registry, workspaceRoot);
  registerActiveEditorTools(registry);
  registerTodoTool(registry, (todos) => provider?.updateTodos(todos));
  if (vscode.workspace.getConfiguration('fibonacci').get<boolean>('enableMCP')) {
    registerMcpTools(registry, mcpManager, {
      onServersChanged: () => provider?.refreshServers(),
    });
  }

  // --- Webview provider ---
  const provider = new FibonacciAgentViewProvider(context, {
    client,
    registry,
    approvals,
    mcpManager,
    workspaceRoot,
  });
  approvals.setPendingHandler((req) => provider.forwardApprovalRequest(req));
  approvals.setUpdateHandler(() => provider.refreshPendingApprovals());

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'fibonacci.agentView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('fibonacci.configure', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'fibonacci');
    }),
    vscode.commands.registerCommand('fibonacci.newChat', () => {
      provider.newChat();
    }),
    vscode.commands.registerCommand('fibonacci.switchModel', async () => {
      const models = getModelChoices();
      const pick = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.label, description: m.description, id: m.id })),
        { placeHolder: 'مدل Fibonacci را انتخاب کنید' }
      );
      if (pick) provider.switchModel(pick.id);
    }),
    vscode.commands.registerCommand('fibonacci.addMcpServer', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'نام سرور MCP را وارد کنید',
        placeHolder: 'مثال: playwright',
      });
      if (!name) return;
      const command = await vscode.window.showInputBox({
        prompt: 'دستور اجرای سرور MCP را وارد کنید',
        placeHolder: 'npx',
      });
      if (!command) return;
      const argsStr = await vscode.window.showInputBox({
        prompt: 'آرگومان‌ها (با کاما جدا کنید)',
        placeHolder: '@anthropic-ai/mcp-server-playwright',
      });
      const args = argsStr ? argsStr.split(',').map((s) => s.trim()) : [];
      const server: McpServerConfig = { name, command, args };
      const cfg = vscode.workspace.getConfiguration('fibonacci');
      const servers = (cfg.get<McpServerConfig[]>('mcpServers') ?? []).slice();
      servers.push(server);
      await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global);
      try {
        await mcpManager.connect(server);
        vscode.window.showInformationMessage(`سرور MCP «${name}» متصل شد.`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `خطا در اتصال به سرور MCP: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      provider.refreshServers();
    })
  );

  // --- React to config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fibonacci')) {
        client.refresh();
        approvals.setAutoApproveReadOnly(
          vscode.workspace.getConfiguration('fibonacci').get<boolean>('autoApproveReadOnly') ?? true
        );
        provider.pushConfig();
      }
    })
  );

  // Auto-connect to configured MCP servers at startup (best-effort)
  if (vscode.workspace.getConfiguration('fibonacci').get<boolean>('enableMCP')) {
    const servers = vscode.workspace
      .getConfiguration('fibonacci')
      .get<McpServerConfig[]>('mcpServers') ?? [];
    for (const s of servers) {
      mcpManager.connect(s).catch(() => {
        /* silent — surfaced via list_mcp_tools */
      });
    }
  }
}

export function deactivate(): void {
  // Nothing to clean up — file/terminal/MCP tools are stateless or self-managed.
}

export function getModelChoices(): ModelChoice[] {
  const cfg = vscode.workspace.getConfiguration('fibonacci');
  const econ = cfg.get<string>('defaultModel') ?? 'fibonacci-1-pro-max';
  const pro = cfg.get<string>('professionalModel') ?? 'fibonacci-1-agentic';
  return [
    {
      id: econ,
      label: 'اقتصادی (' + econ + ')',
      description: 'مناسب برای کارهای روزمره و سریع',
    },
    {
      id: pro,
      label: 'حرفه‌ای (' + pro + ')',
      description: 'مناسب برای وظایف پیچیده و چندمرحله‌ای',
    },
  ];
}

export function getCurrentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('fibonacci');
  return {
    apiKeySet: !!cfg.get<string>('apiKey'),
    baseURL: cfg.get<string>('baseURL') ?? 'http://my.fibonacci.monster/api/v1',
    defaultModel: cfg.get<string>('defaultModel') ?? 'fibonacci-1-pro-max',
    professionalModel: cfg.get<string>('professionalModel') ?? 'fibonacci-1-agentic',
    language: (cfg.get<string>('language') as 'fa' | 'en') ?? 'fa',
    enableMCP: cfg.get<boolean>('enableMCP') ?? true,
    autoApproveReadOnly: cfg.get<boolean>('autoApproveReadOnly') ?? true,
    maxIterations: cfg.get<number>('maxIterations') ?? 25,
  };
}
