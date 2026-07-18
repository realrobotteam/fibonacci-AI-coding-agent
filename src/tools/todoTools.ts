import type { ToolDefinition, TodoItem } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * Todo list tool — lets the AI create and update a visible task checklist.
 * The AI calls this at the start of a multi-step task with all items
 * (status: pending), then updates individual items to in_progress / completed
 * as it works through them. The webview renders the list in real-time.
 *
 * The executor is a no-op on the host side — the todos are forwarded to the
 * webview via a callback, not executed as a file/terminal operation.
 */

export const todoToolDefinition: ToolDefinition = {
  name: 'update_todos',
  category: 'file', // reuses the "file" category visually; it's a meta-tool
  description:
    'Create or update the visible task checklist. Call this at the start of a multi-step task with ALL items (status: pending), then call it again to update individual item statuses as you progress. Each call REPLACES the entire list — always send the full list, not just changes.',
  parameters: schema(
    {
      todos: {
        type: 'array',
        description: 'Full list of todo items. Each item: { content, status, activeForm }',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What needs to be done (short imperative)' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of this item',
            },
            activeForm: {
              type: 'string',
              description: 'Present-tense description of the current action (e.g. "Reading index.html"). Only needed when status is in_progress.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    ['todos']
  ),
  requiresApproval: false,
  readOnly: true,
};

export function registerTodoTool(
  registry: ToolRegistry,
  onTodosUpdate: (todos: TodoItem[]) => void
): void {
  registry.register(todoToolDefinition, async (args) => {
    const todos = (args.todos as TodoItem[]) ?? [];
    onTodosUpdate(todos);
    return {
      ok: true,
      output: `Todo list updated (${todos.length} items). ${todos.filter((t) => t.status === 'completed').length} completed, ${todos.filter((t) => t.status === 'in_progress').length} in progress, ${todos.filter((t) => t.status === 'pending').length} pending.`,
    };
  });
}
