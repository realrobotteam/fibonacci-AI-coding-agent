import * as crypto from 'node:crypto';
import type { ApprovalRequest, ApprovalResponse, AutoApproveMode } from '../types';
import { ToolRegistry } from './toolRegistry';

interface PendingEntry {
  request: ApprovalRequest;
  resolve: (r: ApprovalResponse) => void;
}

/**
 * The ApprovalManager decides whether a tool call can run automatically or
 * must be confirmed by the user. Rules:
 *
 *  1. If the tool's `requiresApproval` is false → run automatically.
 *  2. If `autoApproveMode` is 'all' → run automatically.
 *  3. If the tool is read-only AND `autoApproveMode` is 'read-only' → run automatically.
 *  4. Otherwise → ask the user (display Persian approval dialog in webview).
 *
 * Pending requests are stored in-memory and resolved when the webview posts
 * an APPROVE message back.
 */
export class ApprovalManager {
  private pending = new Map<string, PendingEntry>();
  private onUpdate: ((reqs: ApprovalRequest[]) => void) | null = null;
  private onPendingHandler: ((req: ApprovalRequest) => void) | null = null;

  constructor(
    private registry: ToolRegistry,
    private autoApproveMode: AutoApproveMode
  ) {}

  setAutoApproveMode(value: AutoApproveMode): void {
    this.autoApproveMode = value;
  }

  setUpdateHandler(fn: (reqs: ApprovalRequest[]) => void): void {
    this.onUpdate = fn;
  }

  setPendingHandler(fn: (req: ApprovalRequest) => void): void {
    this.onPendingHandler = fn;
  }

  /**
   * Decide whether the given tool call needs interactive approval, then
   * either resolve immediately (auto-approved) or wait for the user.
   */
  async requestApproval(params: {
    toolName: string;
    args: Record<string, unknown>;
    description: string;
  }): Promise<ApprovalResponse> {
    const tool = this.registry.get(params.toolName);

    // When autoApproveMode is 'none', ALL tools require approval
    // (overrides requiresApproval: false on individual tools)
    if (this.autoApproveMode === 'none') {
      // fall through to ask the user
    } else {
      // Rule 1: auto-approve tools that don't require approval
      if (tool && !tool.definition.requiresApproval) {
        return { id: '', approved: true };
      }
      // Rule 2: mode-based auto-approve
      if (this.autoApproveMode === 'all') {
        return { id: '', approved: true };
      }
      if (tool && tool.definition.readOnly && this.autoApproveMode === 'read-only') {
        return { id: '', approved: true };
      }
    }

    // Ask the user
    const id = crypto.randomUUID();
    const request: ApprovalRequest = {
      id,
      toolName: params.toolName,
      args: params.args,
      description: params.description,
      ts: Date.now(),
    };

    return new Promise<ApprovalResponse>((resolve) => {
      this.pending.set(id, { request, resolve });
      this.emit();
      this.onPendingHandler?.(request);
    });
  }

  resolve(response: ApprovalResponse): void {
    const entry = this.pending.get(response.id);
    if (entry) {
      entry.resolve(response);
      this.pending.delete(response.id);
      this.emit();
    }
  }

  listPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((e) => e.request);
  }

  private emit(): void {
    this.onUpdate?.(this.listPending());
  }
}

/**
 * Build a Persian human-readable description of a tool call for the approval
 * dialog. Falls back to a generic description for unknown tools.
 */
export function describeToolCall(
  toolName: string,
  args: Record<string, unknown>
): string {
  const argPreview = (key: string, maxLen = 80): string => {
    const v = args[key];
    if (v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  };

  switch (toolName) {
    // File
    case 'read_file':
      return `خواندن فایل: ${argPreview('path')}`;
    case 'write_to_file':
      return `نوشتن فایل: ${argPreview('path')} (${(args.content as string ?? '').length} کاراکتر) — کد در ویرایشگر نمایش داده شد`;
    case 'replace_in_file':
      return `ویرایش فایل: ${argPreview('path')} — تغییرات در ویرایشگر نمایش داده شد`;
    case 'insert_at_line':
      return `درج در خط ${argPreview('line', 10)} فایل: ${argPreview('path')} — در ویرایشگر نمایش داده شد`;
    case 'delete_lines':
      return `حذف خطوط ${argPreview('start_line', 6)}-${argPreview('end_line', 6)} از: ${argPreview('path')} — در ویرایشگر نمایش داده شد`;
    case 'append_to_file':
      return `افزودن به فایل: ${argPreview('path')} (${(args.content as string ?? '').length} کاراکتر) — در ویرایشگر نمایش داده شد`;
    case 'list_files':
      return `فهرست پوشه: ${argPreview('path')}`;
    case 'search_files':
      return `جست‌وجو برای «${argPreview('query')}» در ${argPreview('path', 40)}`;
    case 'grep_search':
      return `جست‌وجوی پیشرفته /${argPreview('pattern', 40)}/ در ${argPreview('path', 40)}`;
    case 'glob_files':
      return `جست‌وجوی فایل ${argPreview('pattern', 40)}`;
    case 'get_active_editor':
      return `خواندن فایل فعال در ویرایشگر`;
    case 'open_file':
      return `باز کردن فایل: ${argPreview('path')}`;
    // Terminal
    case 'execute_command':
      return `اجرای دستور: ${argPreview('command')}`;
    case 'run_in_terminal':
      return `اجرای در ترمینال: ${argPreview('command')}`;
    case 'get_command_output':
      return `دریافت خروجی دستور`;
    // Git
    case 'git_status':
      return `وضعیت گیت${argPreview('path', 40) ? ` در: ${argPreview('path', 40)}` : ''}`;
    case 'git_diff':
      return `تفاوت گیت${argPreview('path', 40) ? ` در: ${argPreview('path', 40)}` : ''}`;
    case 'git_log':
      return `تاریخچه گیت${argPreview('path', 40) ? ` در: ${argPreview('path', 40)}` : ''}`;
    // Editor
    case 'diagnostics':
      return `خطاهای ویرایشگر${argPreview('path', 40) ? ` برای: ${argPreview('path', 40)}` : ' (همه فایل‌ها)'}`;
    case 'format_code':
      return `قالب‌بندی کد: ${argPreview('path')}`;
    case 'document_symbols':
      return `نمادهای فایل: ${argPreview('path')}`;
    case 'workspace_symbols':
      return `جست‌وجوی نمادها: «${argPreview('query')}»`;
    case 'code_actions':
      return `اقدامات کد برای: ${argPreview('path')}`;
    // Web
    case 'web_fetch':
      return `دریافت از وب: ${argPreview('url')}`;
    case 'web_search':
      return `جست‌وجوی وب: «${argPreview('query')}»`;
    // Reasoning / skills
    case 'think':
      return `استدلال (داخلی، بدون اجرا)`;
    case 'list_skills':
      return `فهرست مهارت‌ها`;
    case 'view_skill':
      return `نمایش مهارت: ${argPreview('name')}`;
    case 'invoke_skill':
      return `اجرای مهارت: ${argPreview('name')}`;
    case 'delegate_task':
      return `سپردن وظیفه به ${((args.tasks as unknown[]) ?? []).length} زیرعامل`;
    case 'execute_code':
      return `اجرای اسکریپت ${argPreview('language', 10) || 'python3'} (${(args.script as string ?? '').length} کاراکتر)`;
    case 'memory':
      return `عملیات حافظه (${((args.operations as unknown[]) ?? []).length} عملیات)`;
    // MCP
    case 'list_mcp_tools':
      return `فهرست ابزارهای MCP: ${argPreview('server', 40)}`;
    case 'call_mcp_tool':
      return `فراخوانی MCP: ${argPreview('server')}.${argPreview('tool')}`;
    case 'get_mcp_resources':
      return `دریافت منابع MCP: ${argPreview('server', 40)}`;
    case 'manage_mcp_servers':
      return `مدیریت سرورهای MCP: ${argPreview('action')}`;
    default:
      if (toolName.startsWith('mcp_')) {
        return `ابزار MCP: ${toolName}`;
      }
      return `ابزار: ${toolName}`;
  }
}
