import * as vscode from 'vscode';

/**
 * Repo map — a compact, Aider/Cline-style symbol outline of the workspace's
 * code files, injected into the system prompt so the model gets a cheap
 * orientation over the codebase without reading every file.
 *
 * Design constraints (host must stay snappy and non-fatal):
 *  - 90s module-level cache keyed by workspace root (runs back-to-back reuse it)
 *  - ~120 file candidates max, ≤40 files rendered, 2400-char total budget
 *  - per-file symbol lookup is raced against a 400ms timeout and try/caught —
 *    a slow/missing language server just yields a path-only line
 *  - top-level DocumentSymbol entries only (children ignored)
 *  - ANY error → '' (the section is simply omitted from the prompt)
 */

const CACHE_TTL_MS = 90_000;
const MAX_CANDIDATES = 120;
const MAX_FILES = 40;
const MAX_CHARS = 2400;
const SYMBOLS_PER_FILE = 10;
const SYMBOL_TIMEOUT_MS = 400;

/** Code file extensions rendered in the map (single brace-expanded glob). */
const INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,py,go,rs,java,cs,cpp,c,h,rb,php,vue,svelte}';

const EXCLUDE_GLOB = '**/{node_modules,dist,out,.git}/**';

/** Module-level cache — one entry per workspace root with a 90s TTL. */
let cache: { key: string; text: string; ts: number } | null = null;

/**
 * Build (or fetch from cache) the repository symbol map. Never throws.
 * Returns '' when the workspace has no code files or on any error.
 */
export async function buildRepoMap(workspaceRoot: string): Promise<string> {
  try {
    const now = Date.now();
    if (cache && cache.key === workspaceRoot && now - cache.ts < CACHE_TTL_MS) {
      return cache.text;
    }
    const text = await buildRepoMapUncached();
    cache = { key: workspaceRoot, text, ts: Date.now() };
    return text;
  } catch {
    return '';
  }
}

async function buildRepoMapUncached(): Promise<string> {
  const uris = await vscode.workspace.findFiles(
    INCLUDE_GLOB,
    EXCLUDE_GLOB,
    MAX_CANDIDATES
  );
  if (uris.length === 0) return '';

  // Shallow paths first (fewest path segments, then shorter, then alphabetical)
  // — top-level entry points are the most valuable orientation.
  const relative = new Map<string, string>();
  for (const uri of uris) {
    relative.set(
      uri.toString(),
      vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/')
    );
  }
  uris.sort((a, b) => {
    const ra = relative.get(a.toString()) ?? '';
    const rb = relative.get(b.toString()) ?? '';
    const da = ra.split('/').length;
    const db = rb.split('/').length;
    return da - db || ra.length - rb.length || ra.localeCompare(rb);
  });

  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (const uri of uris) {
    if (included >= MAX_FILES) break;
    const rel = relative.get(uri.toString()) ?? uri.fsPath;
    const symbols = await fileTopLevelSymbols(uri);
    let line = rel;
    if (symbols.length > 0) {
      line += ` — ${symbols.join(', ')}`;
    }
    if (used + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
    included++;
  }

  // Truncation marker so the model knows the outline is partial.
  const skipped = uris.length - included;
  if (skipped > 0) {
    lines.push(`…[repo map truncated — ${skipped} more files]`);
  }
  return lines.join('\n');
}

/**
 * Top-level symbol names of one document, tagged by kind
 * (C=Class F=Function M=Method V=Variable I=Interface S=Struct E=Enum;
 * other kinds are skipped). Raced against a short timeout so a cold
 * language server can't stall the run; errors/timeouts yield [].
 */
async function fileTopLevelSymbols(uri: vscode.Uri): Promise<string[]> {
  try {
    const result = await Promise.race([
      vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        uri
      ),
      new Promise<undefined>((resolve) =>
        setTimeout(() => resolve(undefined), SYMBOL_TIMEOUT_MS)
      ),
    ]);
    if (!Array.isArray(result)) return [];
    const out: string[] = [];
    for (const sym of result) {
      if (out.length >= SYMBOLS_PER_FILE) break;
      const tag = symbolKindTag(sym.kind);
      if (!tag) continue;
      out.push(`${sym.name}:${tag}`);
    }
    return out;
  } catch {
    return [];
  }
}

function symbolKindTag(kind: vscode.SymbolKind): string | null {
  switch (kind) {
    case vscode.SymbolKind.Class: return 'C';
    case vscode.SymbolKind.Function: return 'F';
    case vscode.SymbolKind.Method: return 'M';
    case vscode.SymbolKind.Variable: return 'V';
    case vscode.SymbolKind.Interface: return 'I';
    case vscode.SymbolKind.Struct: return 'S';
    case vscode.SymbolKind.Enum: return 'E';
    default: return null;
  }
}
