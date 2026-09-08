import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closeDiffTabs } from './diffPreview';

/**
 * LiveCodeStreamer — streams file writes into the OFFICIAL VS Code diff
 * editor in real-time as the model generates them (Kilo Code / Cline style).
 *
 * The problem this solves:
 *   - Before: the streamer typed content directly into the real file editor.
 *     The user watched plain code appear and the file was MUTATED on disk
 *     before approval (requiring a fragile revert/delete dance).
 *   - After: as soon as the model starts emitting the `content` parameter of
 *     a write_to_file tool call, a real `vscode.diff` editor opens showing
 *     ORIGINAL vs INCOMING content. Each streamed token updates the diff's
 *     right-hand virtual document live (red/green gutter updates as you
 *     watch). Nothing is ever written to disk pre-approval.
 *
 * Supports THREE streaming formats:
 *   1. Hermes text: `<|tool_call>call:write_to_file{path:"...",content:"..."}<tool_call|>`
 *   2. XML text: `<write_to_file><path>...</path><content>...</content></write_to_file>`
 *   3. OpenAI structured: `delta.tool_calls[].function.arguments` (JSON fragments)
 *
 * For formats 1 and 2, we scan the streaming text buffer for the content
 * parameter and extract new characters as they arrive.
 *
 * For format 3, we track the `arguments` JSON fragments and extract the
 * `content` key as it grows.
 *
 * Escape sequences (\n, \t, \", \\, etc.) are converted on-the-fly so the
 * diff shows actual newlines and tabs, not the literal escape characters.
 */

/** The tools that trigger live diffing. */
const LIVE_CODING_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
]);

// ── Live diff virtual document provider ─────────────────────────────────────

const LIVE_DIFF_SCHEME = 'fibonacci-live-diff';
/** Cap cached virtual documents (each live session leaves 2 entries). */
const MAX_LIVE_DOC_ENTRIES = 60;

class LiveDiffProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    // The uri query carries the cache key (generated id).
    return this.contents.get(uri.query) ?? '';
  }

  set(key: string, content: string): void {
    while (this.contents.size >= MAX_LIVE_DOC_ENTRIES) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    this.contents.set(key, content);
    this.emitter.fire(
      vscode.Uri.from({ scheme: LIVE_DIFF_SCHEME, path: '/update', query: key })
    );
  }

  dispose(): void {
    this.emitter.dispose();
    this.contents.clear();
  }
}

let liveProvider: LiveDiffProvider | null = null;

function ensureLiveProvider(): LiveDiffProvider {
  if (!liveProvider) {
    liveProvider = new LiveDiffProvider();
    vscode.workspace.registerTextDocumentContentProvider(LIVE_DIFF_SCHEME, liveProvider);
  }
  return liveProvider;
}

function liveDiffUri(key: string, name: string, side: 'before' | 'after'): vscode.Uri {
  return vscode.Uri.from({
    scheme: LIVE_DIFF_SCHEME,
    path: `/${side}/${encodeURIComponent(name || 'file')}`,
    query: key,
  });
}

/** A live-updating diff session (one per streamed file write). */
export interface LiveDiffSession {
  beforeUri: vscode.Uri;
  afterUri: vscode.Uri;
  /** Replace the right-hand (incoming) document content and refresh the diff. */
  update(fullContent: string): void;
  /** Force the final authoritative content (post-truncation-guard). */
  setFinal(fullContent: string): void;
  /** Close the diff editor tab(s) showing this session. */
  close(): Promise<void>;
}

function openLiveDiffSession(relPath: string, before: string): LiveDiffSession {
  const provider = ensureLiveProvider();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const beforeKey = `${id}-b`;
  const afterKey = `${id}-a`;
  provider.set(beforeKey, before);
  provider.set(afterKey, '');

  const beforeUri = liveDiffUri(beforeKey, relPath, 'before');
  const afterUri = liveDiffUri(afterKey, relPath, 'after');
  const title = `${relPath} (Fibonacci Diff)`;

  try {
    void vscode.commands.executeCommand(
      'vscode.diff',
      beforeUri,
      afterUri,
      title,
      { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: true }
    );
  } catch (err) {
    console.error('[live-coder] Failed to open live diff editor:', err);
  }

  // Throttle provider updates so a fast token stream doesn't re-render the
  // diff editor on every single delta. Leading-fire + trailing timer.
  let latest = '';
  let lastFire = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    lastFire = Date.now();
    timer = null;
    provider.set(afterKey, latest);
  };

  return {
    beforeUri,
    afterUri,
    update(full: string) {
      latest = full;
      if (timer) return;
      if (Date.now() - lastFire >= 120) {
        flush();
      } else {
        timer = setTimeout(flush, 120);
      }
    },
    setFinal(full: string) {
      latest = full;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Always flush the final content immediately.
      provider.set(afterKey, latest);
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await closeDiffTabs(afterUri);
    },
  };
}

// ── Streaming state ─────────────────────────────────────────────────────────

/** State of the live streamer. */
interface StreamState {
  /** The tool name being streamed (e.g. 'write_to_file'). */
  toolName: string;
  /** The file path being written (as given by the model). */
  filePath: string;
  /** The absolute path on disk (commit target — NOT touched by the streamer). */
  absPath: string;
  /** The live diff session backing the official VS Code diff editor. */
  session: LiveDiffSession;
  /** The content that has been streamed so far (unescaped). */
  streamedContent: string;
  /** Whether the file existed before (nothing on disk was modified). */
  existed: boolean;
  /** The original content (shown on the diff's left side). */
  originalContent: string;
  /** The format being streamed: 'hermes' | 'xml' | 'openai'. */
  format: 'hermes' | 'xml' | 'openai';
  /** For Hermes/XML: the offset in the raw buffer where content starts. */
  contentStartIdx: number;
  /** The quote format used for the content parameter ('qtoken' | 'regular'). */
  contentQuoteFormat: 'qtoken' | 'regular';
}

/**
 * Convert an escape sequence (the character after `\`) to its actual character.
 * Handles: \n \t \r \\ \" \' \/ \b \f \uXXXX
 */
function unescapeAt(s: string, j: number): { char: string; consumed: number } {
  const next = s[j + 1];
  if (next === undefined) return { char: '\\', consumed: 1 };
  switch (next) {
    case 'n': return { char: '\n', consumed: 2 };
    case 't': return { char: '\t', consumed: 2 };
    case 'r': return { char: '\r', consumed: 2 };
    case '\\': return { char: '\\', consumed: 2 };
    case '"': return { char: '"', consumed: 2 };
    case "'": return { char: "'", consumed: 2 };
    case '/': return { char: '/', consumed: 2 };
    case 'b': return { char: '\b', consumed: 2 };
    case 'f': return { char: '\f', consumed: 2 };
    case 'u': {
      const hex = s.slice(j + 2, j + 6);
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        return { char: String.fromCharCode(parseInt(hex, 16)), consumed: 6 };
      }
      return { char: next, consumed: 2 };
    }
    default:
      return { char: next, consumed: 2 };
  }
}

/**
 * Unescape a raw string (with escape sequences) into its actual content.
 *
 * CRITICAL: guards against `undefined` / `null` / non-string input to prevent
 * `Cannot read properties of undefined (reading 'length')` crashes (a bug
 * class seen in v2.0.0 production logs).
 */
function unescapeString(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const { char, consumed } = unescapeAt(raw, i);
      out += char;
      i += consumed;
    } else {
      out += raw[i++];
    }
  }
  return out;
}

/**
 * Resolve a file path to an absolute path, using the workspace root.
 * (Same logic as filePreview.ts — never uses process.cwd().)
 */
function resolveFilePath(p: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    try {
      if (!fs.existsSync(workspaceRoot)) {
        fs.mkdirSync(workspaceRoot, { recursive: true });
      }
    } catch (err) {
      console.error('[live-coder] Failed to create workspace root:', err);
    }
    if (fs.existsSync(workspaceRoot)) {
      if (!p) return workspaceRoot;
      if (path.isAbsolute(p)) return p;
      return path.resolve(workspaceRoot, p);
    }
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    if (!p) return folder;
    if (path.isAbsolute(p)) return p;
    return path.resolve(folder, p);
  }
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
  }
  if (!p) return fallbackDir;
  if (path.isAbsolute(p)) return p;
  return path.resolve(fallbackDir, p);
}

/**
 * Open a LIVE DIFF session for the target file — WITHOUT touching disk.
 * Reads the original content (before) if the file exists; the right side
 * starts empty and fills up as tokens stream in.
 */
function openDiffForLiveCoding(
  filePath: string,
  workspaceRoot?: string
): { session: LiveDiffSession; existed: boolean; originalContent: string; absPath: string } | null {
  const absPath = resolveFilePath(filePath, workspaceRoot);

  // Never stream a "file" that is actually an existing directory.
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      console.error(`[live-coder] Refusing to diff "${absPath}" — it is an existing directory.`);
      return null;
    }
  } catch {
    // Path doesn't exist — fine, the diff shows an empty original side.
  }

  let existed = false;
  let originalContent = '';
  try {
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      existed = true;
      originalContent = fs.readFileSync(absPath, 'utf-8');
    }
  } catch {
    existed = false;
    originalContent = '';
  }

  const session = openLiveDiffSession(filePath, originalContent);
  return { session, existed, originalContent, absPath };
}

export class LiveCodeStreamer {
  private state: StreamState | null = null;
  private workspaceRoot?: string;
  /** Lock to prevent concurrent detectToolCallStart calls (race condition fix). */
  private detecting: Promise<StreamState | null> | null = null;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Process a streaming delta. Scans for file-writing tool calls and, when
   * found, opens the official VS Code diff editor and updates it in real-time.
   *
   * Uses a lock (`this.detecting`) to prevent race conditions where multiple
   * deltas trigger separate detection calls before the first one resolves.
   */
  async processDelta(delta: string, fullBuffer: string): Promise<void> {
    try {
      void delta; // not used directly — we re-scan the full buffer each time

      // Guard against `fullBuffer` being undefined or non-string (malformed
      // API chunks must never crash the streaming pipeline).
      if (typeof fullBuffer !== 'string' || fullBuffer.length === 0) return;

      // Try to detect a file-writing tool call in the buffer.
      if (!this.state && !this.detecting) {
        this.detecting = this.detectToolCallStart(fullBuffer);
      }

      // If detection is in progress, wait for it.
      if (this.detecting) {
        this.state = await this.detecting;
        this.detecting = null;
      }

      if (!this.state) {
        // No file-writing tool call detected yet — nothing to stream.
        return;
      }

      // Extract the new content from the buffer and update the diff.
      this.appendNewContent(fullBuffer);
    } catch (err) {
      console.error('[live-coder] processDelta error:', err);
    }
  }

  /**
   * Process an OpenAI structured tool_call delta. The arguments come as JSON
   * fragments — we track the `content` key and append new characters.
   */
  async processOpenAIDelta(
    toolName: string,
    _argsFragment: string,
    fullArgs: string
  ): Promise<void> {
    try {
      void _argsFragment; // not used directly — we re-scan fullArgs each time
      if (!LIVE_CODING_TOOLS.has(toolName)) return;

      // If this is the first delta for this tool call, open the diff editor.
      // Use the same lock as processDelta to prevent race conditions.
      if (!this.state && !this.detecting) {
        const path = this.extractPathFromPartialJson(fullArgs);
        if (!path) return; // Can't open the diff without a complete path.

        this.detecting = (async () => {
          try {
            const result = openDiffForLiveCoding(path, this.workspaceRoot);
            if (!result) return null;
            const { session, existed, originalContent, absPath } = result;
            return {
              toolName,
              filePath: path,
              absPath,
              session,
              streamedContent: '',
              existed,
              originalContent,
              format: 'openai' as const,
              contentStartIdx: -1,
              contentQuoteFormat: 'regular' as const,
            };
          } catch (err) {
            console.error('[live-coder] Failed to open live diff:', err);
            return null;
          }
        })();
      }

      // Wait for detection to complete.
      if (this.detecting) {
        this.state = await this.detecting;
        this.detecting = null;
      }

      if (!this.state) return;

      // Extract the current content value from the partial JSON.
      const currentContent = this.extractContentFromPartialJson(fullArgs);
      if (currentContent === null) return;

      // Append only the NEW part of the content.
      if (currentContent.length > this.state.streamedContent.length) {
        this.state.streamedContent = currentContent;
        this.state.session.update(currentContent);
      }
    } catch (err) {
      console.error('[live-coder] processOpenAIDelta error:', err);
    }
  }

  /**
   * Detect the start of a file-writing tool call in the streaming buffer.
   * Handles Hermes and XML formats. Opens the live diff editor as soon as
   * the `path` parameter is available.
   */
  private async detectToolCallStart(buffer: string): Promise<StreamState | null> {
    if (typeof buffer !== 'string' || buffer.length === 0) return null;

    // ── Hermes format ──────────────────────────────────────────────────
    // Look for: <|tool_call>call:write_to_file{path:"...",content:"
    const hermesPattern = /<\|tool_call>call:(write_to_file|replace_in_file|insert_at_line|delete_lines|append_to_file)\{/g;
    let m: RegExpExecArray | null;
    while ((m = hermesPattern.exec(buffer)) !== null) {
      const toolName = m[1];
      const argsStart = m.index + m[0].length;
      const argsSlice = buffer.slice(argsStart);

      // Extract the path. Handle BOTH regular quotes ("path") and Hermes
      // Q-token quotes (<|"|>path<|"|>). Only COMPLETE paths match — this
      // prevents partial-path mismatches as the path streams token-by-token.
      const filePath = this.extractPathFromHermesArgs(argsSlice);
      if (!filePath) continue;

      // Find where the content parameter starts (may not have arrived yet).
      // Try BOTH the Gemma4 Q-token format and regular quotes (bug H fix).
      let contentStartIdx = -1;
      let contentQuoteFormat: 'qtoken' | 'regular' = 'regular';
      const qTokenContentMatch = argsSlice.match(/content:\s*<\|"\|>/);
      if (qTokenContentMatch) {
        contentStartIdx = argsStart + (qTokenContentMatch.index ?? 0) + qTokenContentMatch[0].length;
        contentQuoteFormat = 'qtoken';
      } else {
        const regularContentMatch = argsSlice.match(/content:\s*"/);
        if (regularContentMatch) {
          contentStartIdx = argsStart + (regularContentMatch.index ?? 0) + regularContentMatch[0].length;
          contentQuoteFormat = 'regular';
        }
      }

      try {
        const result = openDiffForLiveCoding(filePath, this.workspaceRoot);
        if (!result) return null;
        const { session, existed, originalContent, absPath } = result;
        return {
          toolName,
          filePath,
          absPath,
          session,
          streamedContent: '',
          existed,
          originalContent,
          format: 'hermes',
          contentStartIdx,
          contentQuoteFormat,
        };
      } catch (err) {
        console.error('[live-coder] Failed to open live diff (hermes):', err);
        return null;
      }
    }

    // ── XML format ─────────────────────────────────────────────────────
    // Look for: <write_to_file><path>...</path><content>
    const xmlPattern = /<(write_to_file|replace_in_file|insert_at_line|delete_lines|append_to_file)>/g;
    while ((m = xmlPattern.exec(buffer)) !== null) {
      const toolName = m[1];
      const afterOpen = m.index + m[0].length;
      const afterSlice = buffer.slice(afterOpen);

      const pathMatch = afterSlice.match(/<path>([\s\S]*?)<\/path>/);
      if (!pathMatch) continue;
      const filePath = pathMatch[1].trim();

      let contentStartIdx = -1;
      const contentMatch = afterSlice.match(/<content>([\s\S]*)/);
      if (contentMatch) {
        contentStartIdx = afterOpen + (contentMatch.index ?? 0) + '<content>'.length;
      }

      try {
        const result = openDiffForLiveCoding(filePath, this.workspaceRoot);
        if (!result) return null;
        const { session, existed, originalContent, absPath } = result;
        return {
          toolName,
          filePath,
          absPath,
          session,
          streamedContent: '',
          existed,
          originalContent,
          format: 'xml',
          contentStartIdx,
          contentQuoteFormat: 'regular', // XML doesn't use Q-tokens
        };
      } catch (err) {
        console.error('[live-coder] Failed to open live diff (xml):', err);
        return null;
      }
    }

    return null;
  }

  /**
   * Extract the path value from Hermes-format args. Handles both:
   *   - Regular quotes:  path:"main.py"
   *   - Hermes Q-token:  path:<|"|>main.py<|"|>
   *
   * CRITICAL: Only matches COMPLETE paths (with closing quote). The Q-token
   * regex escapes the `|` characters inside `<|"|>` so they are treated as
   * literal pipes, not regex alternation (bug #1 fix).
   */
  private extractPathFromHermesArgs(args: string): string | null {
    if (!args || typeof args !== 'string') return null;
    // Regular quotes: path:"..." (complete, with closing quote)
    const regularMatch = args.match(/path:\s*"((?:[^"\\]|\\.)*)"/);
    if (regularMatch && regularMatch[1] !== undefined) {
      const pathValue = unescapeString(regularMatch[1]);
      return pathValue || null;
    }
    // Hermes Q-token: path:<|"|>...<|"|> (complete, with closing token)
    const qTokenMatch = args.match(/path:\s*<\|"\|>((?:[^<]|<(?!\|"\|>))*)<\|"\|>/);
    if (qTokenMatch && qTokenMatch[1] !== undefined) {
      const pathValue = unescapeString(qTokenMatch[1]);
      return pathValue || null;
    }
    // No complete path yet — retry on the next delta.
    return null;
  }

  /**
   * Extract the new content from the buffer and update the live diff.
   * Handles Hermes and XML formats with escape sequence conversion.
   */
  private appendNewContent(buffer: string): void {
    if (!this.state) return;

    // If content hasn't started yet, try to find it now.
    if (this.state.contentStartIdx === -1) {
      if (this.state.format === 'hermes') {
        const hermesPattern = /<\|tool_call>call:(?:write_to_file|replace_in_file|insert_at_line|delete_lines|append_to_file)\{/g;
        let m: RegExpExecArray | null;
        while ((m = hermesPattern.exec(buffer)) !== null) {
          const argsStart = m.index + m[0].length;
          const argsSlice = buffer.slice(argsStart);
          // Try Q-token first (canonical Gemma4 format).
          const qTokenMatch = argsSlice.match(/content:\s*<\|"\|>/);
          if (qTokenMatch) {
            this.state.contentStartIdx = argsStart + (qTokenMatch.index ?? 0) + qTokenContentLength(qTokenMatch[0]);
            this.state.contentQuoteFormat = 'qtoken';
            break;
          }
          // Fall back to regular quote.
          const regularMatch = argsSlice.match(/content:\s*"/);
          if (regularMatch) {
            this.state.contentStartIdx = argsStart + (regularMatch.index ?? 0) + regularMatch[0].length;
            this.state.contentQuoteFormat = 'regular';
            break;
          }
        }
      } else if (this.state.format === 'xml') {
        const xmlPattern = /<(?:write_to_file|replace_in_file|insert_at_line|delete_lines|append_to_file)>/g;
        let m: RegExpExecArray | null;
        while ((m = xmlPattern.exec(buffer)) !== null) {
          const afterOpen = m.index + m[0].length;
          const afterSlice = buffer.slice(afterOpen);
          const contentMatch = afterSlice.match(/<content>([\s\S]*)/);
          if (contentMatch) {
            this.state.contentStartIdx = afterOpen + (contentMatch.index ?? 0) + '<content>'.length;
            break;
          }
        }
      }
      if (this.state.contentStartIdx === -1) return; // Content still hasn't started.
    }

    let rawContent: string;

    if (this.state.format === 'hermes') {
      // Content is everything from contentStartIdx until the closing quote.
      rawContent = buffer.slice(this.state.contentStartIdx);

      if (this.state.contentQuoteFormat === 'qtoken') {
        // Q-token format: content ends at the first <|"|> (not escaped).
        let endIdx = 0;
        while (endIdx < rawContent.length) {
          if (rawContent[endIdx] === '\\' && endIdx + 5 < rawContent.length &&
              rawContent.slice(endIdx + 1, endIdx + 6) === '<|"|>') {
            endIdx += 6; // Skip the escaped Q-token
          } else if (rawContent.slice(endIdx, endIdx + 5) === '<|"|>') {
            break; // Found the closing Q-token
          } else {
            endIdx++;
          }
        }
        rawContent = rawContent.slice(0, endIdx);
      } else {
        // Regular quote format: content ends at the first unescaped ".
        let endIdx = 0;
        while (endIdx < rawContent.length) {
          if (rawContent[endIdx] === '\\' && endIdx + 1 < rawContent.length) {
            endIdx += 2;
          } else if (rawContent[endIdx] === '"') {
            break;
          } else {
            endIdx++;
          }
        }
        rawContent = rawContent.slice(0, endIdx);
      }
    } else if (this.state.format === 'xml') {
      // Content is everything from contentStartIdx until </content>.
      rawContent = buffer.slice(this.state.contentStartIdx);
      const endIdx = rawContent.indexOf('</content>');
      if (endIdx !== -1) {
        rawContent = rawContent.slice(0, endIdx);
      }
    } else {
      return; // OpenAI format handled separately.
    }

    // Unescape the raw content.
    const unescaped = unescapeString(rawContent);

    // Update the diff only when the content actually grew.
    if (unescaped.length > this.state.streamedContent.length) {
      this.state.streamedContent = unescaped;
      this.state.session.update(unescaped);
    }
  }

  /**
   * Extract the `path` value from a partial JSON arguments string.
   * Only matches COMPLETE paths (with closing quote).
   */
  private extractPathFromPartialJson(json: string): string | null {
    if (!json || typeof json !== 'string') return null;
    const m = json.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m && m[1] !== undefined) return unescapeString(m[1]);
    return null;
  }

  /**
   * Extract the `content` value from a partial JSON arguments string.
   * Returns the unescaped content so far, or null if content hasn't started.
   */
  private extractContentFromPartialJson(json: string): string | null {
    if (!json || typeof json !== 'string') return null;
    const startIdx = json.indexOf('"content"');
    if (startIdx === -1) return null;

    let i = startIdx + '"content"'.length;
    while (i < json.length && (json[i] === ' ' || json[i] === ':')) i++;

    if (json[i] !== '"') return null;
    i++;

    let raw = '';
    while (i < json.length) {
      if (json[i] === '\\' && i + 1 < json.length) {
        raw += json[i] + json[i + 1];
        i += 2;
      } else if (json[i] === '"') {
        break;
      } else {
        raw += json[i++];
      }
    }

    return unescapeString(raw);
  }

  /**
   * Get the final state when streaming is complete. The caller uses
   * `content` for approval diffing and `setFinal` to sync the authoritative
   * (post-truncation-guard) content back into the diff editor.
   */
  getFinalState(): {
    toolName: string;
    filePath: string;
    absPath: string;
    content: string;
    existed: boolean;
    originalContent: string;
    /** Push the authoritative final content into the live diff editor. */
    setFinal: (content: string) => void;
    /** Virtual URIs of the open live diff (for handle reuse). */
    uris: { before: vscode.Uri; after: vscode.Uri } | null;
  } | null {
    if (!this.state) return null;
    return {
      toolName: this.state.toolName,
      filePath: this.state.filePath,
      absPath: this.state.absPath,
      content: this.state.streamedContent,
      existed: this.state.existed,
      originalContent: this.state.originalContent,
      setFinal: (content: string) => {
        if (this.state) this.state.session.setFinal(content);
      },
      uris: this.state
        ? { before: this.state.session.beforeUri, after: this.state.session.afterUri }
        : null,
    };
  }

  /** Reset the streamer for the next tool call (leaves the diff tab open). */
  reset(): void {
    this.state = null;
  }

  /**
   * Called by the agent loop when the stream failed/was aborted BEFORE any
   * content arrived for a NEW file — the diff would show an empty-vs-empty
   * view, so close it. Nothing on disk was ever touched, so no deletion.
   */
  async cleanupEmptyFile(): Promise<void> {
    if (!this.state) return;
    const { existed, streamedContent, session } = this.state;
    if (!existed && streamedContent.length === 0) {
      await session.close().catch(() => { /* best-effort */ });
    }
    this.state = null;
  }

  /**
   * Clean up after an aborted stream — close the diff tab (nothing on disk
   * was modified by the streamer, so there is nothing to revert).
   */
  async cleanup(): Promise<void> {
    if (this.state) {
      await this.state.session.close().catch(() => { /* best-effort */ });
    }
    this.state = null;
  }

  /**
   * Close the live diff editor tab once the tool has finished executing
   * (approved+committed or rejected). The chat card keeps a persistent
   * "open diff" button so the user can re-open a before/after view later.
   */
  async closeDiffEditor(): Promise<void> {
    if (!this.state) return;
    await this.state.session.close().catch(() => { /* best-effort */ });
    this.state = null;
  }
}

/** qTokenContentMatch[0] is `content:<|"|>` — its full length is the offset. */
function qTokenContentLength(matched: string): number {
  return matched.length;
}
