import OpenAI from 'openai';
import * as vscode from 'vscode';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ChatCompletionCreateParamsBase, ChatCompletionChunk } from 'openai/resources/chat/completions';

/**
 * Map a raw API error to a helpful Error. Shared by the pre-stream and
 * mid-stream catch blocks (previously the same logic was triplicated).
 */
function mapApiError(err: unknown, baseURL: string, opts?: { midStream?: boolean }): Error {
  // err.message can be undefined for OpenAI SDK errors — guard against that.
  const errMsg = err instanceof Error
    ? (typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : `Unknown ${err.name || 'Error'} (no message)`)
    : (err != null ? String(err) : 'Unknown error (undefined)');

  if (errMsg.includes('402') || /insufficient credits?/i.test(errMsg)) {
    return new Error(
      'اعتبار حساب شما کافی نیست (402 Insufficient credits). لطفاً حساب کاربری خود را شارژ کنید و دوباره تلاش کنید. ' +
      '(Insufficient credits — please top up your account balance and try again.)'
    );
  }
  if (errMsg.includes('context_length_exceeded') || errMsg.includes('maximum context length')) {
    return new Error(
      'مکالمه خیلی طولانی شد (context_length_exceeded). لطفاً گفتگوی جدیدی شروع کنید یا تنظیمات فشرده‌سازی زمینه را بررسی کنید.\n' +
      '(The conversation is too long. Please start a new chat or check context compression settings.)'
    );
  }
  // The API server may be behind a reverse proxy that returns an HTML error
  // page (Cloudflare 502, nginx maintenance page, etc.) — the SDK then fails
  // JSON parsing with "Unexpected token '<'".
  if (errMsg.includes('Unexpected token') && errMsg.includes('<')) {
    return new Error(
      `API server returned an HTML page ${opts?.midStream ? 'mid-stream ' : ''}instead of JSON. This usually means the API endpoint (${baseURL}) is down for maintenance or behind a misconfigured reverse proxy. ` +
      `Original error: ${errMsg}. Please check the base URL in settings.`
    );
  }
  const prefix = opts?.midStream ? 'Stream interrupted: ' : 'API request failed: ';
  return new Error(`${prefix}${errMsg}. Check your API key, base URL, and network connection.`);
}

/**
 * Fibonacci API client — wraps the official OpenAI SDK pointed at the
 * Fibonacci OpenAI-compatible endpoint. Provides streaming chat completions
 * with tool-calling support.
 */
export class FibonacciClient {
  private client: OpenAI | null = null;
  private baseURL!: string;
  private apiKey!: string;
  /** Cached OpenAI instances keyed by "baseURL\u0000apiKey" — lets individual
   *  runs route through a CONNECTED PROVIDER's credentials (Providers tab)
   *  without rebuilding the SDK client on every call. */
  private clients = new Map<string, OpenAI>();

  constructor() {
    this.refresh();
  }

  refresh(): void {
    const cfg = vscode.workspace.getConfiguration('fibonacci');
    this.baseURL = cfg.get<string>('baseURL') ?? 'https://my.fibonacci.monster/api/v1';
    this.apiKey = cfg.get<string>('apiKey') ?? '';

    if (this.apiKey) {
      this.client = this.clientFor(this.baseURL, this.apiKey);
    } else {
      this.client = null;
    }
  }

  /** Get (or lazily build) an SDK client for explicit credentials. */
  private clientFor(baseURL: string, apiKey: string): OpenAI {
    const key = `${baseURL}\u0000${apiKey}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAI({ apiKey, baseURL });
      this.clients.set(key, client);
    }
    return client;
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
    /** Optional per-call credentials — when BOTH are set, this call routes
     *  through the given OpenAI-compatible endpoint instead of the global
     *  fibonacci baseURL/apiKey (used for connected-provider routing). */
    baseURL?: string;
    apiKey?: string;
  }): Promise<{
    content: string;
    toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }>;
    finishReason: string;
    /** Token usage for this call — reported by the server when available,
     *  otherwise estimated (≈4 chars/token). */
    usage: { promptTokens: number; completionTokens: number };
  }> {
    // Resolve the client for this call: explicit per-call credentials (a
    // connected provider) win over the global fibonacci credentials.
    const hasOverride = typeof params.baseURL === 'string' && params.baseURL.length > 0
      && typeof params.apiKey === 'string' && params.apiKey.length > 0;
    const client = hasOverride
      ? this.clientFor(params.baseURL!, params.apiKey!)
      : this.client;
    if (!client) {
      throw new Error(
        'کلید API تنظیم نشده است. لطفاً از تنظیمات Fibonacci کلید خود را وارد کنید یا یک ارائه‌دهنده متصل انتخاب کنید.'
      );
    }
    const requestBaseURL = hasOverride ? params.baseURL! : this.baseURL;

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
      stream = (await client.chat.completions.create(
        requestBody,
        { signal: params.signal }
      )) as AsyncIterable<ChatCompletionChunk>;
    } catch (err) {
      // Log the full error for debugging, then re-throw with a helpful message.
      console.error('[fibonacci-agent] API request failed:', err);
      throw mapApiError(err, requestBaseURL);
    }

    let content = '';
    const toolCallMap = new Map<number, { id: string; name: string; argsRaw: string }>();
    let finishReason = 'stop';
    // Usage metering: OpenAI-compatible servers MAY include `usage` on the
    // final chunk (prompt_tokens/completion_tokens). When absent we estimate
    // from message lengths after the loop (≈4 chars/token).
    let reportedUsage: { promptTokens: number; completionTokens: number } | null = null;
    const buildUsage = (): { promptTokens: number; completionTokens: number } => {
      if (reportedUsage) return reportedUsage;
      let promptTokens = 0;
      for (const m of params.messages) {
        promptTokens += Math.ceil(String((m as { content?: unknown }).content ?? '').length / 4);
      }
      return { promptTokens, completionTokens: Math.ceil(content.length / 4) };
    };

    // CRITICAL FIX (bug #3): Wrap the streaming iteration in try/catch.
    // The OpenAI SDK's SSE parser throws when the server returns an HTML
    // error page mid-stream (e.g. the server crashes mid-response and a
    // reverse proxy returns a 502 HTML page). Without this catch, the error
    // bubbles up as an unhandled promise rejection and shows up in the log
    // as `[Extension Host] undefined` followed by a SyntaxError stack trace.
    try {
      for await (const chunk of stream) {
        if (params.signal?.aborted) break;
        const rawUsage = (
          chunk as unknown as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null }
        ).usage;
        if (
          rawUsage &&
          typeof rawUsage.prompt_tokens === 'number' &&
          typeof rawUsage.completion_tokens === 'number'
        ) {
          reportedUsage = {
            promptTokens: rawUsage.prompt_tokens,
            completionTokens: rawUsage.completion_tokens,
          };
        }
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
        return { content, toolCalls: [], finishReason: 'abort', usage: buildUsage() };
      }
      console.error('[fibonacci-agent] Stream iteration error:', err);
      if (params.signal?.aborted) {
        return { content, toolCalls: [], finishReason: 'abort', usage: buildUsage() };
      }
      // Return whatever content was streamed so far, plus an error note.
      // This is more useful than throwing — the user sees partial output
      // and a clear error message rather than a generic crash.
      if (content) {
        content += `\n\n[Stream interrupted: ${mapApiError(err, this.baseURL).message}]`;
      } else {
        throw mapApiError(err, this.baseURL, { midStream: true });
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

    return { content, toolCalls, finishReason, usage: buildUsage() };
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
