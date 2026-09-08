import * as vscode from 'vscode';

/**
 * Ghost-text inline autocompletion (opt-in, Tier-3 wave 20).
 *
 * Registers a single InlineCompletionItemProvider for ALL languages. The
 * provider reads its own `fibonacci.*` configuration live on every call —
 * nothing is passed in from extension.ts. Opt-in via `fibonacci.ghostText`
 * (default FALSE) because every accepted keystroke costs an API call.
 *
 * Behavior contract:
 *  - Skips when disabled, no apiKey, non-file schemes, cursor in leading
 *    whitespace, too little context, or an active selection.
 *  - Result cache keyed by languageId|prefix (cap 20, LRU-ish).
 *  - Single-flight: one in-flight completion; a new call ABORTS the previous
 *    one. Never queues — typing always wins.
 *  - Non-streaming POST {baseURL}/chat/completions with a 4s timeout; the
 *    model is prompted to output ONLY the literal continuation at <CURSOR>.
 *  - Every error path returns [] silently (one console.debug per session).
 */

const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;
const MAX_TOKENS = 64;
const API_TIMEOUT_MS = 4000;
const CACHE_CAP = 20;
/** Minimum typed context before we spend an API call. */
const MIN_LINE_PREFIX = 4;
const MIN_DOC_PREFIX = 24;

/** LRU-ish result cache keyed by `${languageId}|${prefix}` (cap 20). */
const resultCache = new Map<string, string>();

/** Single-flight controller — at most one completion in flight at a time. */
let inFlight: AbortController | null = null;

/** console.debug at most once per session (the feature is silent by design). */
let debugLogged = false;
function debugOnce(msg: string): void {
  if (debugLogged) return;
  debugLogged = true;
  console.debug(`[fibonacci-agent] ghostText: ${msg}`);
}

export function registerGhostTextProvider(): vscode.Disposable {
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      _context: vscode.InlineCompletionContext,
      token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
      try {
        return await provideCompletions(document, position, token);
      } catch (err) {
        // All errors → [] silently (one debug line per session max).
        debugOnce(`provider error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    },
  };

  const registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider
  );

  // The result cache is keyed by document content, so it self-invalidates as
  // the user types — no document listeners needed today. Disposable.from()
  // leaves room to co-register any future listeners in the same disposable.
  return vscode.Disposable.from(registration);
}

async function provideCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.InlineCompletionItem[]> {
  // Read config LIVE per call (no cached settings, no constructor state).
  const cfg = vscode.workspace.getConfiguration('fibonacci');
  const enabled = cfg.get<boolean>('ghostText') ?? false;
  if (!enabled) return [];
  const apiKey = cfg.get<string>('apiKey') ?? '';
  if (!apiKey) return [];
  if (document.uri.scheme !== 'file') return [];

  // Skip when the user has an active selection (replacement intent, not
  // completion intent). Read event-less from the live editor when it is the
  // same document — the provider params only give us document + position.
  const editor = vscode.window.activeTextEditor;
  if (
    editor &&
    editor.document.uri.toString() === document.uri.toString() &&
    !editor.selection.isEmpty
  ) {
    return [];
  }

  const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
  // Skip when the cursor sits in leading whitespace.
  if (linePrefix.trim().length === 0) return [];

  const fullText = document.getText();
  const offset = document.offsetAt(position);
  // Skip when there is not enough context to bother the API: a very short
  // non-whitespace line prefix AND a very short document prefix.
  if (linePrefix.trim().length < MIN_LINE_PREFIX && offset < MIN_DOC_PREFIX) return [];

  // Context window: last 2000 chars before the cursor (split at a line
  // boundary when the window is full) + next 500 chars after it.
  let start = Math.max(0, offset - PREFIX_CHARS);
  if (start > 0) {
    const nl = fullText.indexOf('\n', start);
    if (nl !== -1 && nl < offset) start = nl + 1;
  }
  const prefix = fullText.slice(start, offset);
  const suffix = fullText.slice(offset, offset + SUFFIX_CHARS);

  const key = `${document.languageId}|${prefix}`;
  const cached = resultCache.get(key);
  if (cached !== undefined) {
    // LRU refresh: re-insert so eviction drops the LEAST recently used.
    resultCache.delete(key);
    resultCache.set(key, cached);
    return buildItems(cached, document, position);
  }

  const text = await fetchCompletion(
    {
      apiKey,
      baseURL: cfg.get<string>('baseURL') ?? 'https://my.fibonacci.monster/api/v1',
      model: cfg.get<string>('defaultModel') ?? 'fibonacci-1-pro-max',
    },
    document.fileName,
    document.languageId,
    prefix,
    suffix,
    token
  );
  if (token.isCancellationRequested) return [];
  if (!text) return [];

  resultCache.set(key, text);
  if (resultCache.size > CACHE_CAP) {
    // Evict the oldest entry (Map iteration order = insertion order; the
    // refresh-on-hit above keeps this approximately LRU).
    const oldest = resultCache.keys().next();
    if (!oldest.done) resultCache.delete(oldest.value);
  }
  return buildItems(text, document, position);
}

/**
 * POST /chat/completions (non-streaming) and return the cleaned literal
 * continuation, or '' when there is nothing worth showing.
 */
async function fetchCompletion(
  opts: { apiKey: string; baseURL: string; model: string },
  fileName: string,
  languageId: string,
  prefix: string,
  suffix: string,
  token: vscode.CancellationToken
): Promise<string> {
  // Single-flight: a new call aborts the previous one. NEVER queue.
  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const cancelSub = token.onCancellationRequested(() => controller.abort());
  try {
    const resp = await fetch(`${opts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          {
            role: 'system',
            content:
              'You are a code completion engine. Continue the code exactly at the <CURSOR> marker. Output ONLY the literal continuation text — no markdown fences, no explanations, no repetition of existing code.',
          },
          {
            role: 'user',
            content: `File: ${fileName} (${languageId})\n\n${prefix}<CURSOR>${suffix}`,
          },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      debugOnce(`completion HTTP ${resp.status}`);
      return '';
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let text = stripMarkdownFences(data.choices?.[0]?.message?.content ?? '');
    // Trim ONE leading newline max — the replace range starts mid-line, so
    // more than one leading newline would visually break the line.
    if (text.startsWith('\r\n')) text = text.slice(2);
    else if (text.startsWith('\n')) text = text.slice(1);
    // Degenerate outputs: empty/whitespace, or a literal repeat of code that
    // already exists at the tail of the prefix.
    if (!text.trim()) return '';
    if (prefix.endsWith(text)) return '';
    return text;
  } catch {
    // Timeout / single-flight abort / network error / bad JSON — all silent.
    return '';
  } finally {
    clearTimeout(timer);
    cancelSub.dispose();
    if (inFlight === controller) inFlight = null;
  }
}

/** Strip a wrapping ```lang … ``` fence (models emit them; ghost text must not show them). */
function stripMarkdownFences(s: string): string {
  const closed = s.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (closed) return closed[1];
  // Unclosed fence (hit max_tokens mid-block): drop the opening fence line.
  const open = s.match(/^\s*```[^\n]*\n([\s\S]*)$/);
  if (open) return open[1];
  return s;
}

/** Build the completion item: replace from the cursor to the END OF THE CURRENT LINE only. */
function buildItems(
  text: string,
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.InlineCompletionItem[] {
  const replaceRange = new vscode.Range(position, document.lineAt(position.line).range.end);
  return [new vscode.InlineCompletionItem(text, replaceRange)];
}
