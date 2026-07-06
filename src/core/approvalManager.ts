import * as crypto from 'node:crypto';
import type { ApprovalRequest, ApprovalResponse } from '../types';
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
 *  2. If the tool is read-only AND `fibonacci.autoApproveReadOnly` is true → run automatically.
 *  3. Otherwise → ask the user (display Persian approval dialog in webview).
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
    private autoApproveReadOnly: boolean
  ) {}

  setAutoApproveReadOnly(value: boolean): void {
    this.autoApproveReadOnly = value;
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

    // Rule 1 & 2: auto-approve safe operations
    if (tool && !tool.definition.requiresApproval) {
      return { id: '', approved: true };
    }
    if (tool && tool.definition.readOnly && this.autoApproveReadOnly) {
      return { id: '', approved: true };
    }

    // Rule 3: ask the user
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
    case 'read_file':
      return `خواندن فایل: ${argPreview('path')}`;
    case 'write_to_file':
      return `نوشتن فایل: ${argPreview('path')} (${(args.content as string ?? '').length} کاراکتر)`;
    case 'replace_in_file':
      return `ویرایش فایل: ${argPreview('path')}`;
    case 'list_files':
      return `فهرست پوشه: ${argPreview('path')}`;
    case 'search_files':
      return `جست‌وجو برای «${argPreview('query')}» در ${argPreview('path', 40)}`;
    case 'execute_command':
      return `اجرای دستور: ${argPreview('command')}`;
    case 'run_in_terminal':
      return `اجرای در ترمینال: ${argPreview('command')}`;
    case 'get_command_output':
      return `دریافت خروجی دستور`;
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
