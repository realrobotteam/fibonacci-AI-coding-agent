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
    this.baseURL = cfg.get<string>('baseURL') ?? 'https://my.fibonacci.monster/api/v1';
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
    onToolCallDelta?: (toolName: string, argsFragment: string, fullArgs: string) => void;
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

    // Build the request body. Only include `tools` and `tool_choice` when
    // they are provided — some APIs reject `tools: undefined` or
    // `tools: null`.
    const requestBody = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.3,
      stream: true,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
    } as ChatCompletionCreateParamsBase;

    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        requestBody,
        { signal: params.signal }
      )) as AsyncIterable<ChatCompletionChunk>;
    } catch (err) {
      // Log the full error for debugging, then re-throw with a helpful message.
      console.error('[fibonacci-agent] API request failed:', err);
      // CRITICAL FIX (bug F): err.message can be undefined for OpenAI SDK errors.
      // Guard against that to prevent `errMsg.includes(...)` from throwing TypeError.
      const errMsg = err instanceof Error
        ? (typeof err.message === 'string' && err.message.length > 0 ? err.message : `Unknown ${err.name || 'Error'} (no message)`)
        : (err != null ? String(err) : 'Unknown error (undefined)');
      // CRITICAL FIX (bug #4 in vscode-app-1783401153690.log):
      // The Fibonacci API returns "402 Insufficient credits" when the user's
      // account is out of credit. The agent loop was logging this as a
      // generic "API request failed" error with no actionable guidance.
      // Detect 402 specifically and surface a clearer message.
      if (errMsg.includes('402') || /insufficient credits?/i.test(errMsg)) {
        throw new Error(
          'اعتبار حساب شما کافی نیست (402 Insufficient credits). لطفاً حساب کاربری خود را شارژ کنید و دوباره تلاش کنید. ' +
          '(Insufficient credits — please top up your account balance and try again.)'
        );
      }
      // CRITICAL FIX (bug #3 in vscode-app-1783401153690.log):
      // When the API server is misconfigured or behind a reverse proxy that
      // returns an HTML error page (e.g. Cloudflare 502, nginx maintenance
      // page, etc.), the OpenAI SDK tries to parse the response as JSON and
      // throws "SyntaxError: Unexpected token '<', '<html><hea'... is not
      // valid JSON". Detect this case and provide a clearer message.
      if (errMsg.includes('Unexpected token') && errMsg.includes('<')) {
        throw new Error(
          `API server returned an HTML page instead of JSON. This usually means the API endpoint (${this.baseURL}) is down for maintenance or behind a misconfigured reverse proxy. ` +
          `Original error: ${errMsg}. Please check the base URL in settings.`
        );
      }
      throw new Error(`API request failed: ${errMsg}. Check your API key, base URL, and network connection.`);
    }

    let content = '';
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason = 'stop';

    // CRITICAL FIX (bug #3): Wrap the streaming iteration in try/catch.
    // The OpenAI SDK's SSE parser throws when the server returns an HTML
    // error page mid-stream (e.g. the server crashes mid-response and a
    // reverse proxy returns a 502 HTML page). Without this catch, the error
    // bubbles up as an unhandled promise rejection and shows up in the log
    // as `[Extension Host] undefined` followed by a SyntaxError stack trace.
    try {
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
            if (tc.function?.arguments) {
              entry.argsRaw += tc.function.arguments;
              // Surface the tool_call delta to the live coder so it can open
              // the editor and show code in real-time.
              if (params.onToolCallDelta) {
                params.onToolCallDelta(entry.name, tc.function.arguments, entry.argsRaw);
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (err) {
      // If the user aborted, just stop — not an error.
      if (params.signal?.aborted) {
        return { content, toolCalls: [], finishReason: 'abort' };
      }
      console.error('[fibonacci-agent] Stream iteration error:', err);
      // CRITICAL FIX (bug F): Same guard as above — err.message can be undefined.
      const errMsg = err instanceof Error
        ? (typeof err.message === 'string' && err.message.length > 0 ? err.message : `Unknown ${err.name || 'Error'} (no message)`)
        : (err != null ? String(err) : 'Unknown error (undefined)');
      // Same 402 detection for mid-stream errors.
      if (errMsg.includes('402') || /insufficient credits?/i.test(errMsg)) {
        throw new Error(
          'اعتبار حساب شما کافی نیست (402 Insufficient credits). لطفاً حساب کاربری خود را شارژ کنید و دوباره تلاش کنید. ' +
          '(Insufficient credits — please top up your account balance and try again.)'
        );
      }
      // Same HTML-page detection for mid-stream errors.
      if (errMsg.includes('Unexpected token') && errMsg.includes('<')) {
        throw new Error(
          `API server returned an HTML page mid-stream instead of JSON. The connection was likely interrupted by a reverse proxy or maintenance page. ` +
          `Original error: ${errMsg}.`
        );
      }
      // Return whatever content was streamed so far, plus an error note.
      // This is more useful than throwing — the user sees partial output
      // and a clear error message rather than a generic crash.
      if (content) {
        content += `\n\n[Stream interrupted: ${errMsg}]`;
      } else {
        throw new Error(`Stream interrupted: ${errMsg}`);
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

  /**
   * Send a simple non-streaming prompt to the model and return the response.
   * Used for tasks like prompt improvement where we don't need streaming
   * or tool calls.
   */
  async improvePrompt(prompt: string, model?: string): Promise<string> {
    if (!this.client) {
      throw new Error(
        'کلید API تنظیم نشده است. لطفاً از تنظیمات Fibonacci کلید خود را وارد کنید.'
      );
    }

    const useModel = model || 'fibonacci-1-pro-max';
    try {
      const response = await this.client.chat.completions.create({
        model: useModel,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
        stream: false,
      });

      const content = response.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content.trim() : '';
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[fibonacci-agent] improvePrompt failed:', errMsg);
      throw new Error(`Failed to improve prompt: ${errMsg}`);
    }
  }
}
