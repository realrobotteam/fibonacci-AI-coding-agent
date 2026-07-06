import * as vscode from 'vscode';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * get_active_editor tool — lets the AI read the file the user currently has
 * open in VS Code's active editor, without needing to be told the path.
 *
 * This solves the problem where the user has a file open but the AI can't
 * see it unless the user explicitly mentions the filename.
 */

export const activeEditorToolDefinitions: ToolDefinition[] = [
  {
    name: 'get_active_editor',
    category: 'file',
    description:
      'Read the file currently open in the user\'s active VS Code editor. Use this when the user references "this file", "the current file", or "my open file" without naming it. Returns { path, content, languageId, selection }.',
    parameters: schema(
      {
        include_selection: {
          type: 'boolean',
          description: 'If true (default), include the currently-selected text range. If false, return only the full file content.',
        },
      }
    ),
    requiresApproval: false,
    readOnly: true,
  },
];

export function registerActiveEditorTools(registry: ToolRegistry): void {
  registry.register(activeEditorToolDefinitions[0], async (args) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        ok: false,
        output: 'No active editor. The user does not have a file open in VS Code.',
      };
    }

    const document = editor.document;
    const filePath = vscode.workspace.asRelativePath(document.uri);
    const content = document.getText();
    const languageId = document.languageId;
    const includeSelection = args.include_selection !== false;

    let selectionInfo = '';
    if (includeSelection && !editor.selection.isEmpty) {
      const sel = editor.selection;
      const selectedText = document.getText(sel);
      selectionInfo = `\n\n[Selection: lines ${sel.start.line + 1}-${sel.end.line + 1}]\n${selectedText}`;
    }

    const meta = `Active file: ${filePath} (${languageId}, ${document.lineCount} lines)${selectionInfo ? ' [with selection]' : ''}\n\n--- Content ---\n`;

    return {
      ok: true,
      output: meta + content + selectionInfo,
    };
  });
}
