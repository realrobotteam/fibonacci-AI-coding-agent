import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { FibonacciClient } from './api/fibonacciClient';
import { ToolRegistry } from './core/toolRegistry';
import { ApprovalManager } from './core/approvalManager';
import { SkillsRegistry, registerBuiltInSkills } from './core/skillsRegistry';
import { registerFileTools } from './tools/fileTools';
import { registerTerminalTools } from './tools/terminalTools';
import { McpManager, registerMcpTools } from './tools/mcpTools';
import { registerTodoTool } from './tools/todoTools';
import { registerActiveEditorTools } from './tools/activeEditorTools';
import { registerWebTools } from './tools/webTools';
import { registerSearchTools } from './tools/searchTools';
import { registerGitTools } from './tools/gitTools';
import { registerEditorTools } from './tools/editorTools';
import { registerCodeEditTools } from './tools/codeEditTools';
import { registerReasoningTools, registerSkillsTools } from './tools/reasoningTools';
import { registerMemoryTools } from './tools/memoryTools';
import { registerExecuteCodeTools } from './tools/executeCodeTools';
import { registerDelegateTaskTools, setDelegateTaskDeps } from './tools/delegateTaskTools';
import { FibonacciAgentViewProvider } from './webviewProvider';
import type { AgentConfig, AgentMode, AutoApproveMode, McpServerConfig, ModelChoice, ProviderConfig } from './types';

/**
 * Determine the workspace root. If the user has a folder open in VS Code,
 * use that. Otherwise, fall back to ~/Documents/fibonacci-agent (created
 * automatically) instead of process.cwd() which would point to the VS Code
 * installation directory on Windows.
 */
function getWorkspaceRoot(): string {
  // CRITICAL FIX (bug L2): Ensure the workspace folder EXISTS before using it.
  // If the folder doesn't exist (e.g., it was deleted), fall back to the
  // ~/Documents/fibonacci-agent directory.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    try {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        console.debug(`[fibonacci-agent] Created workspace folder: ${folder}`);
      }
      if (fs.existsSync(folder)) return folder;
    } catch (err) {
      console.error('[fibonacci-agent] Failed to create workspace folder:', err);
    }
  }
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
      console.debug(`[fibonacci-agent] Created fallback workspace: ${fallbackDir}`);
    } catch (err) {
      console.error('[fibonacci-agent] Failed to create fallback dir:', err);
    }
  }
  return fallbackDir;
}

function getDefaultProviderConfigs(): ProviderConfig[] {
  return [
    {
      id: 'fibonacci',
      name: 'Fibonacci AI',
      baseURL: 'https://my.fibonacci.monster/api/v1',
      apiKey: '',
      models: getModelChoices(),
      enabled: true,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      models: [
        { id: 'gpt-4o', label: 'GPT-4o', description: 'Most capable model', outputCost: 15 },
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast and affordable', outputCost: 0.6 },
        { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', description: 'High performance', outputCost: 10 },
        { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', description: 'Fast and cost-effective', outputCost: 0.5 },
      ],
      enabled: false,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKey: '',
      models: [
        { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', description: 'Best balance of speed and intelligence', outputCost: 15 },
        { id: 'claude-3-opus', label: 'Claude 3 Opus', description: 'Most capable model', outputCost: 75 },
        { id: 'claude-3-haiku', label: 'Claude 3 Haiku', description: 'Fast and lightweight', outputCost: 0.25 },
      ],
      enabled: false,
    },
    {
      id: 'custom',
      name: 'Custom (OpenAI-compatible)',
      baseURL: '',
      apiKey: '',
      models: [],
      enabled: false,
    },
  ];
}

// Module-level reference for cleanup in deactivate()
let mcpManager: McpManager | null = null;

export function activate(context: vscode.ExtensionContext): void {
  console.debug('[fibonacci-agent] activate() called');

  // CRITICAL FIX (bug F in vscode-app-1783403753675.log):
  // Install global unhandled-rejection and uncaught-exception handlers.
  //
  // The log file showed ~50 entries of `[Extension Host] undefined` with NO
  // stack trace. These are unhandled Promise rejections where the rejection
  // value is `undefined`. The OpenAI SDK's internal stream parser (SSE
  // parser) can reject promises with `undefined` when the API server returns
  // an HTML error page instead of JSON — the SDK's `fromSSEResponse` function
  // has a `finally { a.abort() }` block, and the abort can trigger a
  // secondary rejection with `undefined`.
  //
  // Without these handlers, VS Code logs the bare `undefined` to the
  // console and the Output channel, filling the log with noise and giving
  // the user no clue about what went wrong.
  //
  // With these handlers, we:
  //   1. Intercept the rejection/exception
  //   2. Extract a meaningful message (even from `undefined`/`null`)
  //   3. Log it with the `[fibonacci-agent]` prefix and a stack trace (if any)
  //   4. Surface it to the user via the Output channel (not a popup — too noisy)
  const outputChannel = vscode.window.createOutputChannel('Fibonacci Agent');
  context.subscriptions.push(outputChannel);

  const formatRejection = (reason: unknown): string => {
    if (reason == null) {
      return 'Unhandled rejection: value was undefined or null (likely from the OpenAI SDK stream parser). ' +
        'This usually means the API server returned an HTML error page instead of JSON. ' +
        'Check the base URL and network connection.';
    }
    if (reason instanceof Error) {
      const msg = reason.message || '(empty error message)';
      const stack = reason.stack || '(no stack trace)';
      return `Unhandled rejection: ${reason.name}: ${msg}\n${stack}`;
    }
    if (typeof reason === 'string') {
      return `Unhandled rejection: ${reason}`;
    }
    try {
      return `Unhandled rejection: ${JSON.stringify(reason)}`;
    } catch {
      return `Unhandled rejection: ${String(reason)}`;
    }
  };

  const rejectionHandler = (reason: unknown) => {
    const formatted = formatRejection(reason);
    console.error('[fibonacci-agent]', formatted);
    outputChannel.appendLine(`[ERROR] ${formatted}`);
  };

  const exceptionHandler = (err: unknown) => {
    const formatted = formatRejection(err);
    console.error('[fibonacci-agent] Uncaught exception:', formatted);
    outputChannel.appendLine(`[FATAL] ${formatted}`);
  };

  process.on('unhandledRejection', rejectionHandler);
  process.on('uncaughtException', exceptionHandler);

  // Clean up the handlers when the extension is deactivated.
  context.subscriptions.push({
    dispose: () => {
      process.off('unhandledRejection', rejectionHandler);
      process.off('uncaughtException', exceptionHandler);
    }
  });

  const workspaceRoot = getWorkspaceRoot();

  if (!vscode.workspace.workspaceFolders?.[0]) {
    vscode.window.showInformationMessage(
      `Fibonacci: چون پوشه‌ای باز نیست، فایل‌ها در «${workspaceRoot}» ذخیره می‌شوند. برای تغییر، یک پوشه در VS Code باز کنید.`
    );
  }

  // --- Core services ---
  const client = new FibonacciClient();
  const registry = new ToolRegistry();
  const skills = new SkillsRegistry();
  const approvals = new ApprovalManager(
    registry,
    (vscode.workspace.getConfiguration('fibonacci').get<string>('autoApproveMode') as AutoApproveMode) ?? 'none'
  );
  mcpManager = new McpManager();

  // --- Register skills ---
  registerBuiltInSkills(skills);

  // --- Register tools ---
  // File operations (existing)
  registerFileTools(registry, workspaceRoot);
  registerCodeEditTools(registry); // new: insert_at_line, delete_lines, append_to_file
  // Terminal (existing)
  registerTerminalTools(registry, workspaceRoot);
  // Active editor (existing)
  registerActiveEditorTools(registry);
  // Todo (existing)
  registerTodoTool(registry, (todos) => provider?.updateTodos(todos));
  // Web (new)
  registerWebTools(registry);
  // Search (new)
  registerSearchTools(registry);
  // Git (new)
  registerGitTools(registry);
  // Editor intelligence (new)
  registerEditorTools(registry);
  // Reasoning / meta (new)
  registerReasoningTools(registry);
  // Skills (new)
  registerSkillsTools(registry, skills);
  // Memory (new — persistent cross-session declarative facts)
  registerMemoryTools(registry);
  // Execute code (new — run Python/JS scripts that call tools programmatically)
  registerExecuteCodeTools(registry, {
    registry,
    workspaceRoot,
    context,
  });
  // Delegate task is registered below after the provider is created (it needs
  // the model + hermesMode which are read from the provider/config).
  // MCP (existing, optional)
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
    skills,
    workspaceRoot,
  });

  // Listen for theme changes and notify webview
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      const themeKind = theme.kind === vscode.ColorThemeKind.Light ? 'light' :
                        theme.kind === vscode.ColorThemeKind.HighContrast ? 'high-contrast' : 'dark';
      provider.sendToWebview({ type: 'THEME_CHANGE', theme: themeKind });
    })
  );

  // Send initial theme
  const initialThemeKind = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' :
                           vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast ? 'high-contrast' : 'dark';
  provider.sendToWebview({ type: 'THEME_CHANGE', theme: initialThemeKind });
  approvals.setPendingHandler((req) => provider.forwardApprovalRequest(req));
  approvals.setUpdateHandler(() => provider.refreshPendingApprovals());

  // --- Delegate task (needs client + registry + skills + workspaceRoot + model) ---
  // Wire up the deps that delegate_task will use to spawn subagents.
  const initialCfg = vscode.workspace.getConfiguration('fibonacci');
  setDelegateTaskDeps({
    client,
    registry,
    skills,
    workspaceRoot,
    model: initialCfg.get<string>('defaultModel') ?? 'fibonacci-1-pro-max',
    hermesMode: initialCfg.get<boolean>('hermesMode') ?? true,
    language: (initialCfg.get<string>('language') as 'fa' | 'en') ?? 'fa',
  });
  registerDelegateTaskTools(registry);

  // Refresh delegate_task deps when the model or hermesMode changes.
  provider.onModelChanged((model) => {
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    setDelegateTaskDeps({
      client,
      registry,
      skills,
      workspaceRoot,
      model,
      hermesMode: cfg.get<boolean>('hermesMode') ?? true,
      language: (cfg.get<string>('language') as 'fa' | 'en') ?? 'fa',
    });
  });

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
        await mcpManager!.connect(server);
        vscode.window.showInformationMessage(`سرور MCP «${name}» متصل شد.`);
      } catch (err) {
        vscode.window.showErrorMessage(
          `خطا در اتصال به سرور MCP: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      provider.refreshServers();
    }),
    vscode.commands.registerCommand('fibonacci.showSkills', async () => {
      const list = skills.list();
      const pick = await vscode.window.showQuickPick(
        list.map((s) => ({
          label: s.name,
          description: s.description,
          detail: `Category: ${s.category}`,
        })),
        { placeHolder: 'مهارت‌های موجود' }
      );
      if (pick) {
        const s = skills.get(pick.label);
        if (s) {
          const doc = await vscode.workspace.openTextDocument({
            content: `# ${s.name}\n\n**Category:** ${s.category}\n**Description:** ${s.description}\n\n${s.body}`,
            language: 'markdown',
          });
          await vscode.window.showTextDocument(doc);
        }
      }
    })
  );

  // --- React to config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fibonacci')) {
        client.refresh();
        approvals.setAutoApproveMode(
          (vscode.workspace.getConfiguration('fibonacci').get<string>('autoApproveMode') as AutoApproveMode) ?? 'none'
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
  mcpManager?.disconnectAll().catch(() => {});
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
      outputCost: econ === 'fibonacci-1-pro-max' ? 1 : econ === 'fibonacci-2-coder' ? 2 : econ === 'fibonacci-2-sentiment' ? 1 : 7,
    },
    {
      id: pro,
      label: 'حرفه‌ای (' + pro + ')',
      description: 'مناسب برای وظایف پیچیده و چندمرحله‌ای',
      outputCost: pro === 'fibonacci-1-pro-max' ? 1 : pro === 'fibonacci-1-agentic' ? 7 : pro === 'fibonacci-2-coder' ? 2 : pro === 'fibonacci-2-sentiment' ? 1 : 0,
    },
    {
      id: 'fibonacci-2-coder',
      label: 'کد‌نویس 2.0 (' + 'fibonacci-2-coder' + ')',
      description: 'مدل متخصص برای تولید و اصلاح کد',
      outputCost: 2,
    },
    {
      id: 'fibonacci-2-sentiment',
      label: 'آنالیزگر احساسات (' + 'fibonacci-2-sentiment' + ')',
      description: 'مدل تخصصی برای تحلیل احساسات در متن',
      outputCost: 1,
    },
  ];
}

export function getCurrentConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('fibonacci');
  const defaultModel = cfg.get<string>('defaultModel') ?? 'fibonacci-1-pro-max';
  const professionalModel = cfg.get<string>('professionalModel') ?? 'fibonacci-1-agentic';
  
  // Get model assignments for each mode
  const modelAssignments: Record<AgentMode, string> = {
    coding: cfg.get<string>('modelAssignment.coding') ?? defaultModel,
    plan: cfg.get<string>('modelAssignment.plan') ?? professionalModel,
    ask: cfg.get<string>('modelAssignment.ask') ?? defaultModel,
    debug: cfg.get<string>('modelAssignment.debug') ?? professionalModel,
    auto: cfg.get<string>('modelAssignment.auto') ?? defaultModel,
  };

  // Get provider configurations
  const savedProviders = cfg.get<ProviderConfig[]>('providers') ?? [];
  const defaultProviders = getDefaultProviderConfigs();
  const providers = defaultProviders.map((dp) => {
    const saved = savedProviders.find((p) => p.id === dp.id);
    return saved ? { ...dp, ...saved } : dp;
  });

  return {
    apiKeySet: !!cfg.get<string>('apiKey'),
    baseURL: cfg.get<string>('baseURL') ?? 'https://my.fibonacci.monster/api/v1',
    defaultModel,
    professionalModel,
    language: (cfg.get<string>('language') as 'fa' | 'en') ?? 'fa',
    enableMCP: cfg.get<boolean>('enableMCP') ?? true,
    autoApproveMode: (cfg.get<string>('autoApproveMode') as AutoApproveMode) ??
      (cfg.get<boolean>('autoApprove') ? 'all' :
       cfg.get<boolean>('autoApproveReadOnly') === false ? 'none' : 'none'),
    maxIterations: cfg.get<number>('maxIterations') ?? 25,
    hermesMode: cfg.get<boolean>('hermesMode') ?? true,
    showReasoning: cfg.get<boolean>('showReasoning') ?? true,
    parallelToolCalls: cfg.get<boolean>('parallelToolCalls') ?? true,
    modelAssignments,
    providers,
    themeBehavior: (cfg.get<string>('themeBehavior') as import('./types').ThemeBehavior) ?? 'auto',
    startupView: (cfg.get<string>('startupView') as import('./types').StartupView) ?? 'last-chat',
    notifyOnTaskComplete: cfg.get<boolean>('notifyOnTaskComplete') ?? true,
    toolOverrides: cfg.get<Record<string, boolean>>('toolOverrides') ?? {},
    contextCompression: (cfg.get<string>('contextCompression') as import('./types').ContextCompression) ?? 'auto',
    historyPath: cfg.get<string>('historyPath') ?? '~/.fibonacci/history',
  };
}
