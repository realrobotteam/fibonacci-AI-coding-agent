import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * LiveCodeStreamer — shows code appearing in the VS Code editor in REAL-TIME
 * as the model streams its response.
 *
 * The problem this solves:
 *   - Before: the model finishes streaming, THEN the editor opens and types
 *     the content with a fake "live typing" effect. The user can't watch the
 *     code being generated.
 *   - After: as soon as the model starts emitting the `content` parameter of
 *     a write_to_file tool call, the editor opens and each token is appended
 *     to the document in real-time. The user watches the code appear as the
 *     model generates it.
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
 * editor shows actual newlines and tabs, not the literal escape characters.
 */

/** The tools that trigger live coding. */
const LIVE_CODING_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
]);

/** State of the live streamer. */
interface StreamState {
  /** The tool name being streamed (e.g. 'write_to_file'). */
  toolName: string;
  /** The file path being written. */
  filePath: string;
  /** The absolute path on disk. */
  absPath: string;
  /** The editor showing the live content. */
  editor: vscode.TextEditor;
  /** The content that has been streamed so far (unescaped). */
  streamedContent: string;
  /** The raw content that has been streamed so far (escaped, for diffing). */
  rawStreamed: string;
  /** Whether the file existed before. */
  existed: boolean;
  /** The original content (for revert). */
  originalContent: string;
  /** The format being streamed: 'hermes' | 'xml' | 'openai'. */
  format: 'hermes' | 'xml' | 'openai';
  /** For Hermes/XML: the offset in the raw buffer where content starts. */
  contentStartIdx: number;
  /** Whether we've opened the editor yet. */
  editorOpened: boolean;
  /** CRITICAL FIX (bug H): The quote format used for the content parameter.
   * 'qtoken' = Gemma4 canonical <|"|>...<|"|>
   * 'regular' = standard "..."
   * Default: 'regular' (backward compatible with older streams).
   */
  contentQuoteFormat: 'qtoken' | 'regular';
}

/**
 * Convert an escape sequence (the character after `\`) to its actual character.
 * Handles: \n \t \r \\ \" \' \/ \b \f \uXXXX
 * Returns the unescaped char and how many input chars were consumed.
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
 * CRITICAL: This function guards against `undefined` / `null` / non-string
 * input to prevent `Cannot read properties of undefined (reading 'length')`
 * crashes. The deployed extension (v2.0.0) crashed hundreds of times in
 * production with exactly this error (see vscode-app-1783401153690.log):
 *
 *   TypeError: Cannot read properties of undefined (reading 'length')
 *       at eo (extension.js:617:534)              // <- this function
 *       at Hs.extractPathFromHermesArgs (...)
 *       at Hs.detectToolCallStart (...)
 *       at Hs.processDelta (...)
 *
 * The defensive checks below ensure that even if a caller passes `undefined`,
 * `null`, a number, or any other non-string value, this function returns ''
 * instead of crashing the entire streaming pipeline.
 */
function unescapeString(raw: string | undefined | null): string {
  // Guard against ALL non-string inputs. The original `if (!raw)` check
  // catches `undefined`, `null`, and `''`, but does NOT catch `0` or
  // `false`. Using `typeof raw !== 'string'` is the safest possible guard.
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
 *
 * CRITICAL FIX (bug L2 — ENOENT persists because workspace root doesn't exist):
 * The previous version used `workspaceRoot` directly WITHOUT checking if it
 * exists. If the workspace root directory doesn't exist on disk (e.g., the
 * user's `~/Documents/fibonacci-agent` folder was deleted), all file writes
 * fail with ENOENT. Now we ensure the workspace root exists before using it.
 */
function resolveFilePath(p: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    // CRITICAL FIX (bug L2): Ensure the workspace root directory exists.
    // If it doesn't, create it with recursive: true.
    try {
      if (!fs.existsSync(workspaceRoot)) {
        fs.mkdirSync(workspaceRoot, { recursive: true });
      }
    } catch (err) {
      console.error('[live-coder] Failed to create workspace root:', err);
      // Fall through to the fallback logic below.
    }
    // Verify the workspace root exists now. If not, fall back.
    if (fs.existsSync(workspaceRoot)) {
      if (!p) return workspaceRoot;
      if (path.isAbsolute(p)) return p;
      return path.resolve(workspaceRoot, p);
    }
    // Workspace root doesn't exist and couldn't be created — fall through.
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    try {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
    } catch {
      // fall through
    }
    if (fs.existsSync(folder)) {
      if (!p) return folder;
      if (path.isAbsolute(p)) return p;
      return path.resolve(folder, p);
    }
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
 * Open a file in VS Code's editor for live coding. Creates an empty file if
 * it doesn't exist.
 *
 * NOTE: This creates the file on disk immediately. Callers MUST ensure that
 * either content is written to it (via commitPreview) or it is cleaned up
 * (via revertPreview or cleanup) if the stream fails.
 */
async function openFileForLiveCoding(
  filePath: string,
  workspaceRoot?: string
): Promise<{ editor: vscode.TextEditor; existed: boolean; originalContent: string; absPath: string } | null> {
  const absPath = resolveFilePath(filePath, workspaceRoot);

  // CRITICAL: Check if a DIRECTORY exists at this path (can happen if a
  // previous run created a partial-path directory). If so, remove it.
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true, force: true });
    }
  } catch {
    // Path doesn't exist — fine.
  }

  const existed = fs.existsSync(absPath);
  let originalContent = '';

  // CRITICAL FIX (bug L — ENOENT on writeFileSync):
  // The parent directory might not exist. Create it with recursive: true,
  // wrapped in try/catch so we don't crash if creation fails. The previous
  // version called mkdirSync WITHOUT a try/catch — if it threw (e.g., due
  // to a race condition or permission issue), the error propagated and the
  // subsequent writeFileSync failed with ENOENT.
  const dir = path.dirname(absPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error('[live-coder] Failed to create parent directory:', err);
    // Don't throw — try the writeFileSync anyway, it might still work
    // if the directory was created by another process in the meantime.
  }

  if (!existed) {
    // CRITICAL FIX (bug C + L): Use retry logic for the initial file creation.
    // On Windows, if a previous run left a lock on the file (or antivirus
    // is scanning), the writeFileSync can fail with EBUSY/EPERM.
    // Also handle ENOENT — the parent directory might not exist despite
    // the mkdirSync above (race condition or permission issue).
    try {
      fs.writeFileSync(absPath, '', 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOENT') {
        // For ENOENT, try creating the parent directory again before retrying.
        if (code === 'ENOENT') {
          try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
          } catch {
            /* ignore — will retry the write below */
          }
        }
        // Retry once after a short delay.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        try {
          fs.writeFileSync(absPath, '', 'utf-8');
        } catch (err2) {
          // CRITICAL FIX (bug L): If the write STILL fails, return null
          // instead of throwing. The live coder will gracefully skip
          // streaming for this file, and the agent loop's fallback
          // (previewToolCall) will handle writing the file properly.
          console.error('[live-coder] Failed to create file after retry:', err2);
          return null;
        }
      } else {
        // For other errors, also return null instead of crashing.
        console.error('[live-coder] Failed to create file:', err);
        return null;
      }
    }
  } else {
    originalContent = fs.readFileSync(absPath, 'utf-8');
  }

  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
  });

  return { editor, existed, originalContent, absPath };
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
   * found, opens the editor and appends content in real-time.
   *
   * CRITICAL: This method uses a lock (`this.detecting`) to prevent race
   * conditions. Multiple deltas can arrive before the first `detectToolCallStart`
   * resolves (because `processDelta` is called with `void` — not awaited).
   * Without the lock, each delta would trigger a separate detection call,
   * each creating a different partial-path file (e.g. "task", "task_",
   * "task_manager", "task_manager.py").
   *
   * @param delta The new text chunk from the model's stream.
   * @param fullBuffer The full accumulated text so far.
   */
  async processDelta(delta: string, fullBuffer: string): Promise<void> {
    try {
      void delta; // not used directly — we re-scan the full buffer each time

      // CRITICAL FIX (bug #2): Guard against `fullBuffer` being undefined or
      // non-string. The streaming pipeline calls this on every token from the
      // API; if the API emits a malformed delta (e.g. an empty chunk or an
      // error object) the `fullBuffer` may be undefined. Without this guard,
      // `detectToolCallStart(undefined)` would crash inside the regex match.
      if (typeof fullBuffer !== 'string' || fullBuffer.length === 0) return;

      // Try to detect a file-writing tool call in the buffer.
      if (!this.state && !this.detecting) {
        // Start detection and store the promise so concurrent calls can wait.
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

      // Extract the new content from the buffer and append to the editor.
      await this.appendNewContent(fullBuffer);
    } catch (err) {
      console.error('[live-coder] processDelta error:', err);
    }
  }

  /**
   * Process an OpenAI structured tool_call delta. The arguments come as JSON
   * fragments — we track the `content` key and append new characters.
   *
   * @param toolName The tool name from delta.tool_calls[].function.name.
   * @param argsFragment The arguments JSON fragment from delta.tool_calls[].function.arguments.
   * @param fullArgs The full accumulated arguments string so far.
   */
  async processOpenAIDelta(
    toolName: string,
    _argsFragment: string,
    fullArgs: string
  ): Promise<void> {
    try {
      void _argsFragment; // not used directly — we re-scan fullArgs each time
      if (!LIVE_CODING_TOOLS.has(toolName)) return;

      // If this is the first delta for this tool call, open the editor.
      // Use the same lock as processDelta to prevent race conditions.
      if (!this.state && !this.detecting) {
        // Try to extract the path from the JSON. Only proceed if the path
        // is complete (has a closing quote).
        const path = this.extractPathFromPartialJson(fullArgs);
        if (!path) return; // Can't open editor without a complete path.

        // Create a promise that resolves to the state, so concurrent calls
        // can wait for it.
        this.detecting = (async () => {
          try {
            // CRITICAL FIX (bug L): Handle null return from openFileForLiveCoding.
            const result = await openFileForLiveCoding(path, this.workspaceRoot);
            if (!result) return null;
            const { editor, existed, originalContent, absPath } = result;
            return {
              toolName,
              filePath: path,
              absPath,
              editor,
              streamedContent: '',
              rawStreamed: '',
              existed,
              originalContent,
              format: 'openai' as const,
              contentStartIdx: -1,
              contentQuoteFormat: 'regular', // OpenAI uses JSON (regular quotes)
              editorOpened: true,
            };
          } catch (err) {
            console.error('[live-coder] Failed to open editor:', err);
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

      // Reveal the start of the document.
      if (this.state.format === 'openai') {
        this.state.editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
      }

      // Extract the current content value from the partial JSON.
      const currentContent = this.extractContentFromPartialJson(fullArgs);
      if (currentContent === null) return;

      // Append only the NEW part of the content.
      if (currentContent.length > this.state.streamedContent.length) {
        const newPart = currentContent.slice(this.state.streamedContent.length);
        await this.appendToEditor(newPart);
        this.state.streamedContent = currentContent;
      }
    } catch (err) {
      console.error('[live-coder] processOpenAIDelta error:', err);
    }
  }

  /**
   * Detect the start of a file-writing tool call in the streaming buffer.
   * Handles Hermes and XML formats.
   *
   * The detector opens the editor as soon as the `path` parameter is
   * available — it does NOT wait for `content` to start. This ensures the
   * editor opens ASAP, even before the model starts emitting code.
   */
  private async detectToolCallStart(buffer: string): Promise<StreamState | null> {
    // CRITICAL FIX (bug #2): Defensive guard — never trust the caller.
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
      // Q-token quotes (<|"|>path<|"|>).
      const filePath = this.extractPathFromHermesArgs(argsSlice);
      if (!filePath) continue;

      // Find where the content parameter starts (may not have arrived yet).
      // CRITICAL FIX (bug H): The Gemma4 template wraps string values in
      // Q-tokens (<|"|>...<|"|>), NOT regular quotes. The previous regex
      // `content:\s*"` only matched regular quotes, so when the model used
      // Q-token format (which is the canonical Gemma4 format), the content
      // start was never found and the live coder never streamed the content.
      //
      // Now we try BOTH formats:
      //   1. Q-token: content:<|"|>  (Gemma4 canonical — from format_argument macro)
      //   2. Regular: content:"      (fallback — some models use this)
      let contentStartIdx = -1;
      let contentQuoteFormat: 'qtoken' | 'regular' = 'regular';
      // Try Q-token first (canonical Gemma4 format).
      const qTokenContentMatch = argsSlice.match(/content:\s*<\|"\|>/);
      if (qTokenContentMatch) {
        contentStartIdx = argsStart + (qTokenContentMatch.index ?? 0) + qTokenContentMatch[0].length;
        contentQuoteFormat = 'qtoken';
      } else {
        // Fall back to regular quote.
        const regularContentMatch = argsSlice.match(/content:\s*"/);
        if (regularContentMatch) {
          contentStartIdx = argsStart + (regularContentMatch.index ?? 0) + regularContentMatch[0].length;
          contentQuoteFormat = 'regular';
        }
      }

      // Open the editor — even if content hasn't started yet, we open the
      // editor so it's ready when the first content token arrives.
      // CRITICAL FIX (bug L): openFileForLiveCoding now returns null on
      // failure (instead of throwing). Handle the null return gracefully.
      try {
        const result = await openFileForLiveCoding(filePath, this.workspaceRoot);
        if (!result) {
          // File couldn't be created — skip this tool call. The agent
          // loop's fallback (previewToolCall) will handle it.
          return null;
        }
        const { editor, existed, originalContent, absPath } = result;
        return {
          toolName,
          filePath,
          absPath,
          editor,
          streamedContent: '',
          rawStreamed: '',
          existed,
          originalContent,
          format: 'hermes',
          contentStartIdx,
          contentQuoteFormat,
          editorOpened: true,
        };
      } catch (err) {
        console.error('[live-coder] Failed to open editor (hermes):', err);
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

      // Extract path.
      const pathMatch = afterSlice.match(/<path>([\s\S]*?)<\/path>/);
      if (!pathMatch) continue;
      const filePath = pathMatch[1].trim();

      // Find where <content> starts (may not have arrived yet).
      let contentStartIdx = -1;
      const contentMatch = afterSlice.match(/<content>([\s\S]*)/);
      if (contentMatch) {
        contentStartIdx = afterOpen + (contentMatch.index ?? 0) + '<content>'.length;
      }

      try {
        // CRITICAL FIX (bug L): Handle null return from openFileForLiveCoding.
        const result = await openFileForLiveCoding(filePath, this.workspaceRoot);
        if (!result) return null;
        const { editor, existed, originalContent, absPath } = result;
        return {
          toolName,
          filePath,
          absPath,
          editor,
          streamedContent: '',
          rawStreamed: '',
          existed,
          originalContent,
          format: 'xml',
          contentStartIdx,
          contentQuoteFormat: 'regular', // XML doesn't use Q-tokens
          editorOpened: true,
        };
      } catch (err) {
        console.error('[live-coder] Failed to open editor (xml):', err);
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
   * CRITICAL: Only matches COMPLETE paths (with closing quote). We do NOT
   * match partial paths (e.g. path:"task when the closing quote hasn't
   * arrived yet). This prevents creating multiple partial-path files
   * (e.g. "task", "task_", "task_manager", "task_manager.py") as the path
   * streams token-by-token.
   *
   * The trade-off: the editor opens slightly later (after the full path
   * arrives, not after the first character). This is acceptable — the path
   * is usually short and arrives within a few tokens.
   */
  private extractPathFromHermesArgs(args: string): string | null {
    if (!args || typeof args !== 'string') return null;
    // Try regular quotes first: path:"..." (complete, with closing quote)
    const regularMatch = args.match(/path:\s*"((?:[^"\\]|\\.)*)"/);
    if (regularMatch && regularMatch[1] !== undefined) {
      const pathValue = unescapeString(regularMatch[1]);
      return pathValue || null;
    }
    // Try Hermes Q-token: path:<|"|>...<|"|> (complete, with closing token)
    //
    // CRITICAL FIX (bug #1 in vscode-app-1783401153690.log):
    // The previous regex was: /path:\s*<\|"|>((?:[^<]|<(?!\|"|>))*)<\|"|>/
    // The unescaped `|` characters inside `<|"|>` were interpreted as regex
    // alternation operators, splitting the pattern into three alternatives:
    //   Alt 1: path:\s*<\|"
    //   Alt 2: >((?:[^<]|<(?!\|"|>))*)<\|"
    //   Alt 3: >
    // When the input contained a `>` (extremely common in JSON, HTML, XML,
    // Hermes tags, etc.), Alt 3 matched a bare `>` and group 1 was undefined.
    // Although the `qTokenMatch[1] !== undefined` guard prevented direct
    // crashes inside extractPathFromHermesArgs, the broken regex NEVER matched
    // a real Q-token path — so the live coder never opened the editor for
    // Q-token-formatted tool calls, and downstream code paths assumed the
    // path had been extracted, leading to undefined values propagating to
    // unescapeString and triggering:
    //   TypeError: Cannot read properties of undefined (reading 'length')
    //   at eo (extension.js:617:534)
    //   at Hs.extractPathFromHermesArgs (extension.js:617:4166)
    //   at Hs.detectToolCallStart (extension.js:617:2923)
    //   at Hs.processDelta (extension.js:617:1660)
    //
    // The fix: escape the `|` characters that are part of the literal `<|"|>`
    // token so they are treated as literal pipes, not alternation. The
    // correct literal pattern is `<\|"\|>` (matches the 5 characters
    // `<`, `|`, `"`, `|`, `>`).
    const qTokenMatch = args.match(/path:\s*<\|"\|>((?:[^<]|<(?!\|"\|>))*)<\|"\|>/);
    if (qTokenMatch && qTokenMatch[1] !== undefined) {
      const pathValue = unescapeString(qTokenMatch[1]);
      return pathValue || null;
    }
    // No complete path yet — return null. The caller will retry on the
    // next delta when more of the path has arrived.
    return null;
  }

  /**
   * Extract the new content from the buffer and append it to the editor.
   * Handles Hermes and XML formats with escape sequence conversion.
   *
   * If contentStartIdx is -1 (content hasn't started yet), try to find it
   * in the current buffer. If still not found, return without appending.
   */
  private async appendNewContent(buffer: string): Promise<void> {
    if (!this.state) return;

    // If content hasn't started yet, try to find it now.
    if (this.state.contentStartIdx === -1) {
      if (this.state.format === 'hermes') {
        // CRITICAL FIX (bug H): Try BOTH Q-token and regular quote formats.
        const hermesPattern = /<\|tool_call>call:(?:write_to_file|replace_in_file|insert_at_line|delete_lines|append_to_file)\{/g;
        let m: RegExpExecArray | null;
        while ((m = hermesPattern.exec(buffer)) !== null) {
          const argsStart = m.index + m[0].length;
          const argsSlice = buffer.slice(argsStart);
          // Try Q-token first (canonical Gemma4 format).
          const qTokenMatch = argsSlice.match(/content:\s*<\|"\|>/);
          if (qTokenMatch) {
            this.state.contentStartIdx = argsStart + (qTokenMatch.index ?? 0) + qTokenMatch[0].length;
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
      // CRITICAL FIX (bug H): Handle BOTH Q-token (<|"|>) and regular (")
      // closing quotes. The format was detected in detectToolCallStart or
      // in the content-start lookup above.
      rawContent = buffer.slice(this.state.contentStartIdx);

      if (this.state.contentQuoteFormat === 'qtoken') {
        // Q-token format: content ends at the first <|"|> (not escaped).
        // The Q-token is 5 characters: < | " | >
        let endIdx = 0;
        while (endIdx < rawContent.length) {
          // Check for escaped Q-token: \<|"|>
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

    // Append only the NEW part.
    if (unescaped.length > this.state.streamedContent.length) {
      const newPart = unescaped.slice(this.state.streamedContent.length);
      await this.appendToEditor(newPart);
      this.state.streamedContent = unescaped;
    }
  }

  /**
   * Append text to the editor at the end of the document.
   *
   * CRITICAL FIX (bug E in vscode-app-1783402941806.log):
   * For large text chunks (>2000 chars), split into smaller pieces to
   * avoid overwhelming VS Code's TextMate tokenizer. The tokenizer can
   * time out if a single edit operation inserts too much content,
   * especially if the content contains very long lines.
   */
  private async appendToEditor(text: string): Promise<void> {
    if (!this.state || !text) return;

    const editor = this.state.editor;
    const doc = editor.document;

    // For large text, insert in chunks to avoid tokenizer timeouts.
    const CHUNK_SIZE = 2000;
    if (text.length > CHUNK_SIZE) {
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        const chunk = text.slice(i, i + CHUNK_SIZE);
        const endPos = doc.positionAt(doc.getText().length);
        await editor.edit((editBuilder) => {
          editBuilder.insert(endPos, chunk);
        });
        // Yield to the event loop so the tokenizer can process the chunk.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } else {
      const endPos = doc.positionAt(doc.getText().length);
      await editor.edit((editBuilder) => {
        editBuilder.insert(endPos, text);
      });
    }

    // Reveal the newly inserted text.
    const newEndPos = doc.positionAt(doc.getText().length);
    const endPos = doc.positionAt(Math.max(0, doc.getText().length - text.length));
    editor.revealRange(
      new vscode.Range(endPos, newEndPos),
      vscode.TextEditorRevealType.Default
    );
  }

  /**
   * Extract the `path` value from a partial JSON arguments string.
   * e.g. `{"path":"main.py","content":"...` → `main.py`
   *
   * CRITICAL: Only matches COMPLETE paths (with closing quote). We do NOT
   * match partial paths to prevent creating multiple partial-path files.
   */
  private extractPathFromPartialJson(json: string): string | null {
    if (!json || typeof json !== 'string') return null;
    // Only match complete: "path":"..." (with closing quote)
    const m = json.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m && m[1] !== undefined) return unescapeString(m[1]);
    // No complete path yet — return null.
    return null;
  }

  /**
   * Extract the `content` value from a partial JSON arguments string.
   * Returns the unescaped content so far, or null if content hasn't started.
   */
  private extractContentFromPartialJson(json: string): string | null {
    if (!json || typeof json !== 'string') return null;
    // Find "content":" in the JSON.
    const startIdx = json.indexOf('"content"');
    if (startIdx === -1) return null;

    // Skip past "content":
    let i = startIdx + '"content"'.length;
    while (i < json.length && (json[i] === ' ' || json[i] === ':')) i++;

    // Expect opening quote.
    if (json[i] !== '"') return null;
    i++;

    // Read until the closing quote (handling escapes).
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
   * Get the final state when streaming is complete. Returns the editor handle
   * so the caller can use it for approval/commit/revert.
   */
  getFinalState(): {
    toolName: string;
    editor: vscode.TextEditor;
    filePath: string;
    absPath: string;
    content: string;
    existed: boolean;
    originalContent: string;
  } | null {
    if (!this.state) return null;
    return {
      toolName: this.state.toolName,
      editor: this.state.editor,
      filePath: this.state.filePath,
      absPath: this.state.absPath,
      content: this.state.streamedContent,
      existed: this.state.existed,
      originalContent: this.state.originalContent,
    };
  }

  /**
   * Reset the streamer for the next tool call.
   */
  reset(): void {
    this.state = null;
  }

  /**
   * Clean up — if the file was newly created by the live coder but no content
   * was streamed (or the stream failed), close the editor and delete the
   * empty file so the user doesn't end up with orphaned empty files.
   *
   * This should be called by the agent loop when:
   *   - The live coder opened a file but the final content is empty
   *   - The preview failed
   *   - The tool call was rejected
   *   - The stream was aborted
   */
  async cleanupEmptyFile(): Promise<void> {
    if (!this.state) return;

    const { absPath, existed, streamedContent } = this.state;

    // Only clean up if:
    // 1. The file didn't exist before (we created it)
    // 2. No content was streamed (it's empty)
    if (!existed && streamedContent.length === 0) {
      // Close the editor
      try {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      } catch {
        /* ignore */
      }
      // CRITICAL FIX (bug C): Wait briefly for VS Code to release the file
      // handle, then delete with retry logic for EBUSY/EPERM on Windows.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      try {
        if (fs.existsSync(absPath)) {
          await unlinkWithRetry(absPath);
        }
      } catch {
        /* ignore */
      }
    }

    this.state = null;
  }

  /**
   * Clean up — close the editor if the stream was aborted.
   */
  async cleanup(): Promise<void> {
    if (this.state && !this.state.existed) {
      // File was newly created — revert by closing and deleting.
      try {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        // CRITICAL FIX (bug C): Wait + retry for EBUSY on Windows.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await unlinkWithRetry(this.state.editor.document.uri.fsPath);
      } catch {
        /* ignore */
      }
    }
    this.state = null;
  }
}

/**
 * Delete a file with retry logic for Windows EBUSY/EPERM errors.
 * (Mirrors the logic in filePreview.ts.)
 */
async function unlinkWithRetry(filePath: string, maxRetries = 5): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        const delay = 20 * Math.pow(2, attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
