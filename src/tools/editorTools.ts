import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * VS Code editor intelligence tools:
 *  - diagnostics: get errors/warnings for a file or all open files
 *  - format_code: format a file using VS Code's active formatter
 *  - document_symbols: get the symbol tree of a file
 *  - workspace_symbols: search workspace symbols
 *  - code_actions: get available quick fixes / refactors
 *  - open_file: open a file in the editor (visual only)
 */

export const editorToolDefinitions: ToolDefinition[] = [
  {
    name: 'diagnostics',
    category: 'editor',
    description:
      'Get VS Code diagnostics (errors, warnings, hints) for a file or all open files. Read-only. Returns severity, message, line/column, and source (e.g. "ts", "eslint"). Useful for verifying code changes — call this after an edit to confirm no new errors were introduced.',
    parameters: schema(
      {
        path: {
          type: 'string',
          description: 'File path (relative or absolute). If omitted, returns diagnostics for all open files.',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'hint'],
          description: 'Filter by severity (default: all)',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['editor', 'read'],
  },
  {
    name: 'format_code',
    category: 'editor',
    description:
      'Format a file using VS Code\'s active formatter (prettier, black, etc.). The file must be openable in VS Code. After formatting, the file is saved and the diagnostics are returned so you can verify the result.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
      },
      ['path']
    ),
    requiresApproval: true,
    tags: ['editor', 'write'],
  },
  {
    name: 'document_symbols',
    category: 'editor',
    description:
      'Get the symbol tree of a file (functions, classes, methods, variables, etc.). Read-only. Returns a flat list with name, kind, range (start/end line), and container. Useful for understanding the structure of a file without reading the whole thing.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
      },
      ['path']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['editor', 'read'],
  },
  {
    name: 'workspace_symbols',
    category: 'editor',
    description:
      'Search workspace symbols by name. Read-only. Returns symbol name, kind, location (file + line), and container. Useful for finding where a function/class is defined across the codebase.',
    parameters: schema(
      {
        query: { type: 'string', description: 'Symbol name (or substring) to search for' },
        limit: { type: 'number', description: 'Max results (default: 50)' },
      },
      ['query']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['editor', 'read'],
  },
  {
    name: 'code_actions',
    category: 'editor',
    description:
      'Get available code actions (quick fixes, refactors) for a file or specific line. Read-only. Returns action title and kind. Use this to discover available refactors before applying them.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Specific line (1-indexed, optional)' },
      },
      ['path']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['editor', 'read'],
  },
  {
    name: 'open_file',
    category: 'editor',
    description:
      'Open a file in VS Code\'s editor (visual only — does not return content). Use this when you want the user to look at a file, or before calling format_code/diagnostics on a file that is not yet open.',
    parameters: schema(
      {
        path: { type: 'string', description: 'File path' },
        preview: { type: 'boolean', description: 'Open in preview mode (default: false)' },
      },
      ['path']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['editor', 'read'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCurrentWorkspaceRoot(): string {
  // CRITICAL FIX (bug L2): Ensure the workspace folder EXISTS before using it.
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    try {
      if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
      }
      if (fs.existsSync(folder)) return folder;
    } catch {
      // fall through
    }
  }
  const home = os.homedir();
  const docsDir = path.join(home, 'Documents');
  const baseDir = fs.existsSync(docsDir) ? docsDir : home;
  const fallbackDir = path.join(baseDir, 'fibonacci-agent');
  if (!fs.existsSync(fallbackDir)) {
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
  }
  return fallbackDir;
}

function resolveWorkspacePath(p: string): string {
  if (!p) return getCurrentWorkspaceRoot();
  if (path.isAbsolute(p)) return p;
  return path.resolve(getCurrentWorkspaceRoot(), p);
}

async function openDocument(filePath: string): Promise<vscode.TextDocument> {
  const uri = vscode.Uri.file(filePath);
  return vscode.workspace.openTextDocument(uri);
}

function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    case vscode.DiagnosticSeverity.Hint: return 'hint';
    default: return 'unknown';
  }
}

function symbolKindName(k: vscode.SymbolKind): string {
  const names: Record<number, string> = {
    0: 'File', 1: 'Module', 2: 'Namespace', 3: 'Package', 4: 'Class',
    5: 'Method', 6: 'Property', 7: 'Field', 8: 'Constructor', 9: 'Enum',
    10: 'Interface', 11: 'Function', 12: 'Variable', 13: 'Constant',
    14: 'String', 15: 'Number', 16: 'Boolean', 17: 'Array', 18: 'Object',
    19: 'Key', 20: 'Null', 21: 'EnumMember', 22: 'Struct', 23: 'Event',
    24: 'Operator', 25: 'TypeParameter',
  };
  return names[k] ?? 'Unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerEditorTools(registry: ToolRegistry): void {
  // diagnostics
  registry.register(editorToolDefinitions[0], async (args) => {
    const severityFilter = args.severity ? String(args.severity) : null;

    // vscode.languages.getDiagnostics has two overloads:
    //   getDiagnostics(): [Uri, Diagnostic[]][]
    //   getDiagnostics(resource: Uri): Diagnostic[]
    // We branch at the call site to keep the types straight.
    let entries: ReadonlyArray<[vscode.Uri, ReadonlyArray<vscode.Diagnostic>]>;
    if (args.path) {
      const targetUri = vscode.Uri.file(resolveWorkspacePath(String(args.path)));
      const diags = vscode.languages.getDiagnostics(targetUri);
      entries = [[targetUri, diags]];
    } else {
      entries = vscode.languages.getDiagnostics();
    }

    const lines: string[] = [];
    let total = 0;
    for (const [uri, diags] of entries) {
      const rel = vscode.workspace.asRelativePath(uri);
      for (const d of diags) {
        const sev = severityName(d.severity);
        if (severityFilter && sev !== severityFilter) continue;
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const src = d.source ? ` [${d.source}]` : '';
        const code = d.code ? ` (${d.code})` : '';
        lines.push(`${rel}:${line}:${col} ${sev}${src}${code}: ${d.message}`);
        total++;
      }
    }

    if (total === 0) {
      return {
        ok: true,
        output: severityFilter
          ? `No ${severityFilter} diagnostics.`
          : 'No diagnostics found.',
      };
    }
    return {
      ok: true,
      output: `[${total} diagnostic${total === 1 ? '' : 's'}]\n${lines.join('\n')}`,
      meta: { count: total },
    };
  });

  // format_code
  registry.register(editorToolDefinitions[1], async (args) => {
    const filePath = resolveWorkspacePath(String(args.path));
    try {
      const doc = await openDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        'vscode.executeFormatDocumentProvider',
        doc.uri,
        { tabSize: 2, insertSpaces: true }
      );
      if (edits && edits.length > 0) {
        const we = new vscode.WorkspaceEdit();
        we.set(doc.uri, edits);
        await vscode.workspace.applyEdit(we);
        await doc.save();
      }
      // Return diagnostics after formatting
      const diags = vscode.languages.getDiagnostics(doc.uri);
      const errors = diags.filter(
        (d) => d.severity === vscode.DiagnosticSeverity.Error
      );
      return {
        ok: true,
        output: `Formatted ${filePath}. Applied ${edits?.length ?? 0} edits. ${errors.length} error(s) remain.`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `Format failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // document_symbols
  registry.register(editorToolDefinitions[2], async (args) => {
    const filePath = resolveWorkspacePath(String(args.path));
    try {
      const doc = await openDocument(filePath);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );
      if (!symbols || symbols.length === 0) {
        return {
          ok: true,
          output: `No symbols found in ${filePath}. (The file may not have a symbol provider for its language.)`,
        };
      }
      const lines: string[] = [];
      const walk = (sym: vscode.DocumentSymbol, depth: number) => {
        const indent = '  '.repeat(depth);
        const startLine = sym.range.start.line + 1;
        const endLine = sym.range.end.line + 1;
        lines.push(
          `${indent}${symbolKindName(sym.kind)} ${sym.name} (L${startLine}-${endLine})`
        );
        if (sym.children) {
          for (const child of sym.children) walk(child, depth + 1);
        }
      };
      symbols.forEach((s) => walk(s, 0));
      return {
        ok: true,
        output: `[${symbols.length} top-level symbol${symbols.length === 1 ? '' : 's'} in ${vscode.workspace.asRelativePath(doc.uri)}]\n${lines.join('\n')}`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `document_symbols failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // workspace_symbols
  registry.register(editorToolDefinitions[3], async (args) => {
    const query = String(args.query);
    const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)));
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      if (!symbols || symbols.length === 0) {
        return { ok: true, output: `No workspace symbols matching "${query}".` };
      }
      const lines = symbols.slice(0, limit).map((s) => {
        const rel = vscode.workspace.asRelativePath(s.location.uri);
        const line = s.location.range.start.line + 1;
        const container = s.containerName ? ` in ${s.containerName}` : '';
        return `${rel}:${line} ${symbolKindName(s.kind)} ${s.name}${container}`;
      });
      const truncated = symbols.length > limit ? `\n[...truncated, ${symbols.length - limit} more...]` : '';
      return {
        ok: true,
        output: `[${symbols.length} symbol${symbols.length === 1 ? '' : 's'} matching "${query}"]\n${lines.join('\n')}${truncated}`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `workspace_symbols failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // code_actions
  registry.register(editorToolDefinitions[4], async (args) => {
    const filePath = resolveWorkspacePath(String(args.path));
    try {
      const doc = await openDocument(filePath);
      let range: vscode.Range;
      if (args.line) {
        const lineIdx = Math.max(0, Number(args.line) - 1);
        range = new vscode.Range(lineIdx, 0, lineIdx, doc.lineAt(lineIdx).text.length);
      } else {
        range = new vscode.Range(0, 0, doc.lineCount - 1, 0);
      }
      const actions = await vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>(
        'vscode.executeCodeActionProvider',
        doc.uri,
        range,
        vscode.CodeActionKind.QuickFix.value
      );
      if (!actions || actions.length === 0) {
        return { ok: true, output: `No code actions for ${filePath}${args.line ? `:${args.line}` : ''}.` };
      }
      const lines = actions.map((a, i) => {
        const kind = (a as vscode.CodeAction).kind?.value ?? 'command';
        return `${i + 1}. [${kind}] ${a.title}`;
      });
      return {
        ok: true,
        output: `[${actions.length} code action${actions.length === 1 ? '' : 's'}]\n${lines.join('\n')}`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `code_actions failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  // open_file
  registry.register(editorToolDefinitions[5], async (args) => {
    const filePath = resolveWorkspacePath(String(args.path));
    const preview = args.preview !== false;
    try {
      const doc = await openDocument(filePath);
      await vscode.window.showTextDocument(doc, {
        preview,
        viewColumn: vscode.ViewColumn.One,
      });
      return {
        ok: true,
        output: `Opened ${vscode.workspace.asRelativePath(vscode.Uri.file(filePath))} in the editor.`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `Failed to open ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}
