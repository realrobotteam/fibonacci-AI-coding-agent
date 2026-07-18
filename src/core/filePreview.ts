import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * FilePreviewManager — handles the "show code in editor BEFORE writing to disk" flow.
 *
 * The problem this solves:
 *   - Bug 1: The approval dialog showed only the file path, not the code. The user
 *     approved "blind" and only saw the code after it was already saved to disk.
 *   - Bug 2: The editor opened AFTER the file was written, so there was no
 *     "live code writing" effect.
 *
 * The fix:
 *   1. For write_to_file / replace_in_file / insert_at_line / delete_lines / append_to_file:
 *      a. Open the file in VS Code's editor (creates if needed).
 *      b. Set the content in the editor (document becomes dirty, NOT saved to disk).
 *      c. For a "live typing" effect, insert the content in chunks with a small delay.
 *      d. Return a handle. The agent loop then asks for approval — the user can
 *         see the full code in the editor while deciding.
 *      e. If approved: save the document to disk.
 *      f. If rejected: revert the document to its original state (or close if new).
 *
 * This ensures:
 *   - The user ALWAYS sees the code before approving.
 *   - Nothing is written to disk until the user approves.
 *   - The "live code writing" effect is visible in the editor.
 */

export interface PreviewHandle {
  /** The URI of the document being previewed. */
  uri: vscode.Uri;
  /** The editor showing the preview. */
  editor: vscode.TextEditor;
  /** The original content (for revert). Empty string if the file didn't exist. */
  originalContent: string;
  /** Whether the file existed before the preview. */
  existed: boolean;
  /** The final content that will be saved on commit. */
  finalContent: string;
}

/**
 * Resolve a workspace-relative or absolute path to an absolute fs path.
 *
 * CRITICAL: Never use `process.cwd()` as a fallback — on Windows, when no
 * folder is open in VS Code, `process.cwd()` returns the VS Code installation
 * directory (e.g. `C:\Program Files\Microsoft VS Code\`), which requires
 * Administrator privileges to write to. This causes "EPERM: operation not
 * permitted" errors.
 *
 * Instead, we fall back to `~/Documents/fibonacci-agent/` (created
 * automatically on first use), matching the logic in `fileTools.ts`.
 *
 * If a `workspaceRoot` is provided (from the ToolContext), we use that.
 */
function resolvePath(p: string, workspaceRoot?: string): string {
  // 1. If the caller provided a workspaceRoot (from the agent loop / context),
  //    use it as the base for relative paths.
  // CRITICAL FIX (bug L2): Ensure the workspace root directory EXISTS.
  // If it doesn't exist, create it with recursive: true. Without this,
  // all file writes fail with ENOENT.
  if (workspaceRoot) {
    try {
      if (!fs.existsSync(workspaceRoot)) {
        fs.mkdirSync(workspaceRoot, { recursive: true });
      }
    } catch (err) {
      console.error('[fibonacci-agent] Failed to create workspace root:', err);
    }
    if (fs.existsSync(workspaceRoot)) {
      if (!p) return workspaceRoot;
      if (path.isAbsolute(p)) return p;
      return path.resolve(workspaceRoot, p);
    }
  }

  // 2. If a VS Code workspace folder is open, use it.
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

  // 3. Fall back to ~/Documents/fibonacci-agent/ (NOT process.cwd()).
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
    } catch {
      /* ignore — will fail later when trying to write */
    }
  }
  if (!p) return fallbackDir;
  if (path.isAbsolute(p)) return p;
  return path.resolve(fallbackDir, p);
}

/**
 * Open a file in VS Code's editor. If the file doesn't exist yet, create it
 * on disk as an empty file first (so we can open it as a real document, not
 * an untitled one — untitled documents can't be auto-saved to a specific path
 * without a save dialog).
 *
 * Returns the editor and the original content.
 */
async function openFileForPreview(filePath: string, workspaceRoot?: string): Promise<{
  editor: vscode.TextEditor;
  originalContent: string;
  existed: boolean;
}> {
  const absPath = resolvePath(filePath, workspaceRoot);

  // CRITICAL: Check if a DIRECTORY exists at this path (can happen if a
  // previous run created a partial-path directory like "task" or "task_").
  // If so, remove it — we need a FILE at this path, not a directory.
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      fs.rmSync(absPath, { recursive: true, force: true });
    }
  } catch {
    // Path doesn't exist — that's fine, we'll create the file below.
  }

  const existed = fs.existsSync(absPath);
  let originalContent = '';

  // CRITICAL FIX (bug L): Ensure the parent directory exists.
  // Wrap in try/catch so mkdirSync failures don't crash the preview.
  const dir = path.dirname(absPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error('[fibonacci-agent] Failed to create parent directory for preview:', err);
    // Don't throw — try the writeFileSync anyway.
  }

  // If the file doesn't exist, create an empty file so we can open it as a
  // real document. (We'll delete it on revert if the user rejects.)
  // CRITICAL FIX (bug C + L): Use retry logic for EBUSY/EPERM/ENOENT.
  if (!existed) {
    try {
      fs.writeFileSync(absPath, '', 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOENT') {
        // For ENOENT, try creating the parent directory again.
        if (code === 'ENOENT') {
          try { fs.mkdirSync(path.dirname(absPath), { recursive: true }); } catch { /* ignore */ }
        }
        await sleep(100);
        try {
          fs.writeFileSync(absPath, '', 'utf-8');
        } catch (err2) {
          // CRITICAL FIX (bug L): Throw with a helpful message instead of
          // a raw ENOENT. The agent loop will catch this and show it to the user.
          throw new Error(
            `Cannot create file "${absPath}": ${(err2 as Error).message}. ` +
            `Make sure the directory exists and you have write permissions.`
          );
        }
      } else {
        throw err;
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

  return { editor, originalContent, existed };
}

/**
 * Replace the entire content of an editor with new content.
 * Uses editor.edit() so the document becomes dirty (unsaved).
 *
 * For the "live typing" effect, the content is inserted in chunks with a
 * small delay between chunks. For large files, the content is still
 * chunked (but with larger chunks and no delay) to avoid overwhelming
 * VS Code's TextMate tokenizer.
 *
 * CRITICAL FIX (bug E in vscode-app-1783402941806.log):
 * The previous version inserted large files (>8000 chars) in a SINGLE
 * `editor.edit()` call. VS Code's TextMate tokenizer then tried to
 * tokenize the entire file at once, hitting the tokenization time limit:
 *   "Time limit reached when tokenizing line: <!DOCTYPE html>..."
 * This caused delayed syntax highlighting and UI freezes.
 *
 * The fix: ALWAYS use chunked insertion, even for large files. For large
 * files, use bigger chunks (2000 chars) with no inter-chunk delay. This
 * gives the tokenizer time to process each chunk incrementally.
 */
async function setEditorContent(
  editor: vscode.TextEditor,
  content: string,
  options?: { liveTyping?: boolean; signal?: AbortSignal }
): Promise<void> {
  const doc = editor.document;
  const liveTyping = options?.liveTyping !== false;
  const signal = options?.signal;

  // Select all existing content and replace it.
  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(doc.getText().length)
  );

  // CRITICAL FIX (bug E): For large content, use chunked insertion with
  // bigger chunks but no delay. This prevents the tokenizer from timing
  // out on a single massive edit operation.
  if (content.length > 8000) {
    const chunkSize = 2000; // ~50 chunks for a 100KB file
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }

    // First chunk: replace all existing content.
    if (chunks.length > 0) {
      await editor.edit((editBuilder) => {
        editBuilder.replace(fullRange, chunks[0]);
      });
    }

    // Subsequent chunks: insert at the end, no delay (fast insertion).
    for (let i = 1; i < chunks.length; i++) {
      if (signal?.aborted) break;
      const endPos = editor.document.positionAt(editor.document.getText().length);
      await editor.edit((editBuilder) => {
        editBuilder.insert(endPos, chunks[i]);
      });
      // Yield to the event loop so the tokenizer can process the chunk.
      // This is critical — without yielding, the tokenizer builds up a
      // backlog and eventually times out.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return;
  }

  if (!liveTyping) {
    // Small content, no live typing — insert all at once.
    await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, content);
    });
    return;
  }

  // Live typing effect: insert content in chunks.
  // For the first chunk, replace the existing content. For subsequent chunks,
  // insert at the end.
  const chunkSize = Math.max(20, Math.floor(content.length / 50)); // ~50 chunks
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  // First chunk: replace all existing content.
  if (chunks.length > 0) {
    await editor.edit((editBuilder) => {
      editBuilder.replace(fullRange, chunks[0]);
    });
  }

  // Subsequent chunks: insert at the end of the document.
  for (let i = 1; i < chunks.length; i++) {
    if (signal?.aborted) break;
    const endPos = editor.document.positionAt(editor.document.getText().length);
    await editor.edit((editBuilder) => {
      editBuilder.insert(endPos, chunks[i]);
    });
    // Small delay to make the typing visible. 8ms is fast enough not to be
    // annoying but slow enough to be visible.
    await sleep(8);
    // Scroll to keep the cursor visible as content is added.
    editor.revealRange(
      new vscode.Range(endPos, editor.document.positionAt(editor.document.getText().length)),
      vscode.TextEditorRevealType.Default
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview functions — one per file-writing tool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Preview a write_to_file operation: open the file in the editor and show the
 * new content (with live typing for small files). The document is NOT saved
 * to disk until commitPreview() is called.
 *
 * Returns a PreviewHandle that must be passed to commitPreview() or
 * revertPreview().
 */
export async function previewWriteToFile(
  filePath: string,
  content: string,
  options?: { liveTyping?: boolean; signal?: AbortSignal; workspaceRoot?: string }
): Promise<PreviewHandle> {
  const { editor, originalContent, existed } = await openFileForPreview(filePath, options?.workspaceRoot);
  await setEditorContent(editor, content, options);
  // Reveal the start of the document so the user sees the beginning.
  editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
  return {
    uri: editor.document.uri,
    editor,
    originalContent,
    existed,
    finalContent: content,
  };
}

/**
 * Preview a replace_in_file operation: open the file, apply the SEARCH/REPLACE
 * diff in the editor (dirty), and return a handle.
 *
 * Throws if the diff is malformed or a SEARCH block is not found.
 */
export async function previewReplaceInFile(
  filePath: string,
  diff: string,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  const { editor, originalContent, existed } = await openFileForPreview(filePath, workspaceRoot);
  if (!existed) {
    throw new Error(`File does not exist: ${filePath}`);
  }

  // Apply the SEARCH/REPLACE blocks to compute the new content.
  const updatedContent = applySearchReplace(originalContent, diff);
  await setEditorContent(editor, updatedContent, { liveTyping: true, signal });

  return {
    uri: editor.document.uri,
    editor,
    originalContent,
    existed,
    finalContent: updatedContent,
  };
}

/**
 * Preview an insert_at_line operation: open the file, insert the content at
 * the specified line (dirty), and return a handle.
 */
export async function previewInsertAtLine(
  filePath: string,
  lineNum: number,
  content: string,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  const { editor, originalContent, existed } = await openFileForPreview(filePath, workspaceRoot);
  const lines = originalContent.split('\n');
  const insertIdx = Math.min(Math.max(0, lineNum - 1), lines.length);
  const insertLines = content.split('\n');
  lines.splice(insertIdx, 0, ...insertLines);
  const updatedContent = lines.join('\n');
  await setEditorContent(editor, updatedContent, { liveTyping: true, signal });
  return {
    uri: editor.document.uri,
    editor,
    originalContent,
    existed,
    finalContent: updatedContent,
  };
}

/**
 * Preview a delete_lines operation: open the file, delete the specified line
 * range (dirty), and return a handle.
 */
export async function previewDeleteLines(
  filePath: string,
  startLine: number,
  endLine: number,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  const { editor, originalContent, existed } = await openFileForPreview(filePath, workspaceRoot);
  if (!existed) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  const lines = originalContent.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  const delCount = end - start;
  lines.splice(start, delCount);
  const updatedContent = lines.join('\n');
  await setEditorContent(editor, updatedContent, { liveTyping: true, signal });
  return {
    uri: editor.document.uri,
    editor,
    originalContent,
    existed,
    finalContent: updatedContent,
  };
}

/**
 * Preview an append_to_file operation: open the file, append the content
 * (dirty), and return a handle.
 */
export async function previewAppendToFile(
  filePath: string,
  content: string,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  const { editor, originalContent, existed } = await openFileForPreview(filePath, workspaceRoot);
  const separator =
    existed && originalContent.length > 0 && !originalContent.endsWith('\n') ? '\n' : '';
  const updatedContent = originalContent + separator + content;
  await setEditorContent(editor, updatedContent, { liveTyping: true, signal });
  return {
    uri: editor.document.uri,
    editor,
    originalContent,
    existed,
    finalContent: updatedContent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit / Revert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit a preview: save the document to disk.
 *
 * CRITICAL FIX (bug G — content truncation):
 * The previous version just called `doc.save()` and assumed the editor
 * content was correct. But when the live coder streamed content into the
 * editor during streaming (via `appendToEditor`), the editor's actual
 * content could be SHORTER than `handle.finalContent` if:
 *   - The streaming was interrupted (e.g., API connection dropped)
 *   - The final chunks didn't arrive before the tool call completed
 *   - A chunked insert was still in progress when commit was called
 *   - VS Code's autoSave fired and saved a partial state
 *
 * This caused files to be saved with truncated content — e.g., a game HTML
 * file that should have been ~5000 characters was saved as 67 characters.
 *
 * The fix: before saving, verify that the editor's actual content matches
 * `handle.finalContent`. If it doesn't match (or is shorter), force-set
 * the editor content to `handle.finalContent` first, then save. This
 * guarantees the full content is always written to disk.
 */
export async function commitPreview(handle: PreviewHandle): Promise<void> {
  // CRITICAL FIX (bug G): Verify the editor content matches finalContent.
  // If not, force-set it before saving. This prevents truncated saves.
  const doc = handle.editor.document;
  const editorContent = doc.getText();

  if (editorContent !== handle.finalContent) {
    // The editor content doesn't match what we expect. This can happen when:
    // 1. The live coder streamed partial content (streaming interrupted)
    // 2. AutoSave fired and saved a partial state
    // 3. A chunked insert was still in progress
    // 4. The editor was modified by another process
    //
    // Force-set the editor to the complete finalContent before saving.
    console.warn(
      `[fibonacci-agent] Editor content mismatch on commit. ` +
      `Editor has ${editorContent.length} chars, expected ${handle.finalContent.length} chars. ` +
      `Force-setting the full content before save.`
    );
    await setEditorContent(handle.editor, handle.finalContent, { liveTyping: false });
  }

  // CRITICAL FIX (bug C): Wrap save() in try/catch — on Windows, doc.save()
  // can briefly fail with EBUSY if another process holds the file. Retry.
  const maxRetries = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await doc.save();
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM') {
        await sleep(20 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Revert a preview: restore the original content (or delete the file if it
 * didn't exist before the preview).
 *
 * CRITICAL: This must work even if VS Code's autoSave has already written
 * the content to disk. We force-delete the file if it was newly created,
 * or overwrite it with the original content if it existed before.
 *
 * CRITICAL FIX (bug C in vscode-app-1783402941806.log):
 * On Windows, when VS Code has a document open and `doc.save()` is called,
 * the file can be briefly locked by the OS. The subsequent `fs.writeFileSync`
 * call races against the save and hits `EBUSY: resource busy or locked`.
 * This was logged hundreds of times as:
 *   "Failed to write original content to disk on revert: Error: EBUSY:
 *    resource busy or locked, open 'c:\Users\SMN\Documents\fibonacci-agent\index.html'"
 *
 * The fix:
 *   1. Wait a short delay after `doc.save()` before touching the file on disk.
 *   2. Use `writeFileSyncWithRetry` instead of `fs.writeFileSync` — it retries
 *      on EBUSY/EPERM with exponential backoff (up to 5 attempts).
 *   3. Similarly wrap `fs.unlinkSync` in retry logic.
 *   4. If all retries fail, fall back to writing via a temp file + rename,
 *      which is atomic on Windows and avoids the lock entirely.
 */
export async function revertPreview(handle: PreviewHandle): Promise<void> {
  const doc = handle.editor.document;
  const absPath = doc.uri.fsPath;

  if (!handle.existed) {
    // The file didn't exist before — we need to close the editor and delete
    // the file from disk.
    //
    // First, try to close THIS specific editor (not just the active one).
    // We use `vscode.window.visibleTextEditors` to find our editor and
    // close it by executing the close command while it's active.
    try {
      // Make our editor the active one, then close it.
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: handle.editor.viewColumn,
        preserveFocus: false,
      });
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } catch {
      /* ignore — editor may already be closed */
    }

    // Give VS Code a moment to release the file handle after closing the
    // editor. On Windows, the OS doesn't release the lock immediately.
    await sleep(50);

    // Force-delete the file from disk with retry logic. This works even if
    // autoSave already wrote content to it or if the file is briefly locked.
    try {
      if (fs.existsSync(absPath)) {
        // Check if it's a directory (shouldn't be, but just in case)
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          fs.rmSync(absPath, { recursive: true, force: true });
        } else {
          await unlinkSyncWithRetry(absPath);
        }
      }
    } catch (err) {
      console.error('[fibonacci-agent] Failed to delete file on revert:', err);
      // If we can't delete, at least truncate it to empty so it's not
      // left with the rejected content.
      try {
        await writeFileSyncWithRetry(absPath, '', 'utf-8');
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // The file existed before — restore the original content.
  // First, set the editor content back to the original.
  try {
    await setEditorContent(handle.editor, handle.originalContent, { liveTyping: false });
    await doc.save();
  } catch (err) {
    console.error('[fibonacci-agent] Failed to restore editor content on revert:', err);
  }

  // Wait briefly for VS Code's save to finish releasing the file lock.
  // On Windows, `doc.save()` returns before the OS fully releases the handle.
  await sleep(50);

  // Also force-write the original content to disk (in case autoSave
  // already wrote the new content). Use retry logic to handle EBUSY.
  try {
    await writeFileSyncWithRetry(absPath, handle.originalContent, 'utf-8');
  } catch (err) {
    console.error('[fibonacci-agent] Failed to write original content to disk on revert:', err);
    // Last resort: write to a temp file and rename. This is atomic on
    // Windows and bypasses any file lock on the destination.
    try {
      const tmpPath = absPath + '.fibonacci-tmp-' + Date.now();
      fs.writeFileSync(tmpPath, handle.originalContent, 'utf-8');
      // On Windows, rename fails if the destination exists. Use
      // fs.renameSync which atomically replaces on most platforms.
      // If rename fails, try copy + delete as a fallback.
      try {
        fs.renameSync(tmpPath, absPath);
      } catch {
        fs.copyFileSync(tmpPath, absPath);
        fs.unlinkSync(tmpPath);
      }
    } catch (err2) {
      console.error('[fibonacci-agent] Temp-file fallback also failed on revert:', err2);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry helpers for Windows file lock issues (EBUSY, EPERM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a file with retry logic. On Windows, `fs.writeFileSync` can fail
 * with EBUSY or EPERM if another process (or VS Code's autoSave) has the
 * file open. We retry with exponential backoff.
 *
 * @param filePath Absolute path to the file.
 * @param data Content to write.
 * @param encoding File encoding (default 'utf-8').
 * @param maxRetries Maximum number of retry attempts (default 5).
 * @returns A promise that resolves when the write succeeds.
 */
async function writeFileSyncWithRetry(
  filePath: string,
  data: string,
  encoding: BufferEncoding = 'utf-8',
  maxRetries = 5
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.writeFileSync(filePath, data, encoding);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      // Retry on EBUSY, EPERM, ENOTEMPTY (Windows lock errors).
      // Don't retry on ENOENT (path doesn't exist) or other errors.
      if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') {
        // Exponential backoff: 20ms, 40ms, 80ms, 160ms, 320ms
        const delay = 20 * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Delete a file with retry logic. Same EBUSY/EPERM handling as
 * `writeFileSyncWithRetry`.
 */
async function unlinkSyncWithRetry(filePath: string, maxRetries = 5): Promise<void> {
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
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH/REPLACE diff application (copied from fileTools.ts to avoid circular import)
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_REPLACE_RE =
  /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

export function applySearchReplace(original: string, diff: string): string {
  let result = original;
  let matches = 0;
  let m: RegExpExecArray | null;
  SEARCH_REPLACE_RE.lastIndex = 0;
  while ((m = SEARCH_REPLACE_RE.exec(diff)) !== null) {
    const [, search, replace] = m;
    const idx = result.indexOf(search);
    if (idx === -1) {
      throw new Error(
        `SEARCH block not found. Make sure the text matches the file exactly:\n${search.slice(0, 120)}…`
      );
    }
    result = result.slice(0, idx) + replace + result.slice(idx + search.length);
    matches++;
  }
  if (matches === 0) {
    throw new Error('No valid SEARCH/REPLACE block found.');
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool name → preview function mapping
// ─────────────────────────────────────────────────────────────────────────────

/** The set of tools that use the preview-then-commit flow. */
export const PREVIEW_TOOLS = new Set([
  'write_to_file',
  'replace_in_file',
  'insert_at_line',
  'delete_lines',
  'append_to_file',
]);

/**
 * Run the preview phase for a file-writing tool. Returns a handle that must
 * be passed to commitPreview() or revertPreview().
 */
export async function previewToolCall(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  workspaceRoot?: string
): Promise<PreviewHandle> {
  switch (toolName) {
    case 'write_to_file':
      return previewWriteToFile(
        String(args.path ?? ''),
        String(args.content ?? ''),
        { liveTyping: true, signal, workspaceRoot }
      );
    case 'replace_in_file':
      return previewReplaceInFile(
        String(args.path ?? ''),
        String(args.diff ?? ''),
        signal,
        workspaceRoot
      );
    case 'insert_at_line':
      return previewInsertAtLine(
        String(args.path ?? ''),
        Number(args.line ?? 1),
        String(args.content ?? ''),
        signal,
        workspaceRoot
      );
    case 'delete_lines':
      return previewDeleteLines(
        String(args.path ?? ''),
        Number(args.start_line ?? 1),
        Number(args.end_line ?? 1),
        signal,
        workspaceRoot
      );
    case 'append_to_file':
      return previewAppendToFile(
        String(args.path ?? ''),
        String(args.content ?? ''),
        signal,
        workspaceRoot
      );
    default:
      throw new Error(`No preview available for tool: ${toolName}`);
  }
}
