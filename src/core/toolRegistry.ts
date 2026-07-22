import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolCategory, ToolDefinition } from '../types';

/**
 * Central registry of all agent tools. Each tool has:
 *  - definition (JSON schema for the LLM)
 *  - executor (async function that runs the tool with validated args)
 *  - approval policy (whether user approval is required before execution)
 *
 * Tools are registered once at activation. MCP tools are added dynamically
 * when MCP servers connect.
 */
export interface ToolExecutor {
  (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  log: (msg: string) => void;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
}

interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(def: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(def.name, { definition: def, executor });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Build the `tools` array consumed by the OpenAI chat-completions API.
   */
  toOpenAITools(): ChatCompletionTool[] {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: `ابزار «${name}» یافت نشد. ممکن است سرور MCP قطع شده باشد.`,
      };
    }
    try {
      return await tool.executor(args ?? {}, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `خطا در اجرای ابزار «${name}»: ${msg}` };
    }
  }
}

/** Helper to build a JSON-Schema object quickly. */
export function schema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    // Note: do NOT include additionalProperties: false — some APIs reject it.
  };
}

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  file: 'فایل',
  terminal: 'ترمینال',
  mcp: 'MCP',
  web: 'وب',
  search: 'جست‌وجو',
  git: 'گیت',
  editor: 'ویرایشگر',
  reasoning: 'استدلال',
  skill: 'مهارت',
  meta: 'متا',
};
