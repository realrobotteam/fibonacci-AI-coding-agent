import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ChatCompletionCreateParamsBase, ChatCompletionChunk } from 'openai/resources/chat/completions';

/**
 * Fibonacci API client — wraps the official OpenAI SDK pointed at the
 * Fibonacci OpenAI-compatible endpoint. Provides streaming chat completions
 * with tool-calling support.
 */
export class FibonacciClient {
  private client: OpenAI | null = null;
  private baseURL!: string;
  private apiKey!: string;

  constructor() {
    this.refresh();
  }

  refresh(): void {
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    this.baseURL = cfg.get<string>('baseURL') ?? 'http://my.fibonacci.monster/api/v1';
    this.apiKey = cfg.get<string>('apiKey') ?? '';

    if (this.apiKey) {
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseURL,
      });
    } else {
      this.client = null;
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  get currentBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Run a single chat-completion turn with tool calling. Returns the assistant
   * message including any tool_calls. Streaming deltas are surfaced via the
   * onDelta callback so the webview can render text token-by-token.
   */
  async chat(params: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
    temperature?: number;
    toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
    onDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<{
    content: string;
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    finishReason: string;
  }> {
    if (!this.client) {
      throw new Error(
        'کلید API تنظیم نشده است. لطفاً از تنظیمات Fibonacci کلید خود را وارد کنید.'
      );
    }

    const requestBody = {
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      temperature: params.temperature ?? 0.3,
      stream: true,
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    } as ChatCompletionCreateParamsBase;

    const stream = (await this.client.chat.completions.create(
      requestBody,
      { signal: params.signal }
    )) as AsyncIterable<ChatCompletionChunk>;

    let content = '';
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason = 'stop';

    for await (const chunk of stream) {
      if (params.signal?.aborted) break;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta?.content) {
        content += delta.content;
        params.onDelta?.(delta.content);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, {
              id: tc.id ?? `call_${Date.now()}_${idx}`,
              name: tc.function?.name ?? '',
              argsRaw: '',
            });
          }
          const entry = toolCallMap.get(idx)!;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.argsRaw += tc.function.arguments;
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    const toolCalls = Array.from(toolCallMap.values()).map((t) => {
      let args: Record<string, unknown> = {};
      if (t.argsRaw) {
        try {
          args = JSON.parse(t.argsRaw);
        } catch {
          args = { _raw: t.argsRaw };
        }
      }
      return { id: t.id, name: t.name, args };
    });

    return { content, toolCalls, finishReason };
  }
}
