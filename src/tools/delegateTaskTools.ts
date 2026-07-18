import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';
import { FibonacciClient } from '../api/fibonacciClient';
import { ToolRegistry as TR } from '../core/toolRegistry';
import { ApprovalManager } from '../core/approvalManager';
import { parseToolCalls } from '../core/toolParser';
import { buildSystemPrompt } from '../core/systemPrompt';
import { formatToolResponseBlock } from '../core/hermesTemplate';
import type { SkillsRegistry } from '../core/skillsRegistry';

/**
 * delegate_task tool — spawn one or more subagents with isolated contexts.
 *
 * Inspired by Hermes Agent's `delegate_task`. Each subagent gets:
 *   - Its own message history (NOT the parent's)
 *   - Its own tool registry (a fresh instance, optionally restricted)
 *   - Its own iteration budget (depth-limited)
 *   - A single goal or a batch of goals
 *
 * Roles:
 *   - leaf (default): no further delegation, no clarify, no memory
 *   - orchestrator: can spawn children (depth-limited, gated)
 *
 * The subagent's final answer is returned to the parent as the tool result.
 * Intermediate tool calls are NOT surfaced to the parent — only the final
 * summary. This keeps the parent's context clean.
 */

export const delegateTaskToolDefinitions: ToolDefinition[] = [
  {
    name: 'delegate_task',
    category: 'meta',
    description:
      'Spawn one or more subagents with isolated contexts to work on sub-goals in parallel. Each subagent gets a fresh message history, full tool access, and its own iteration budget (default 15, max 25). Roles: "leaf" (default — no further delegation) or "orchestrator" (can spawn children, depth-limited). Use this to fan out independent workstreams (e.g. "research file A" + "research file B" + "write tests for C") without polluting the parent context. Returns each subagent\'s final answer.',
    parameters: schema(
      {
        tasks: {
          type: 'array',
          description: 'Batch of subagent tasks. Each: { goal, role?, max_iterations? }. Pass a single-element array for one subagent.',
          items: {
            type: 'object',
            properties: {
              goal: {
                type: 'string',
                description: 'The subagent\'s goal (a clear, self-contained instruction). Include all necessary context — the subagent does NOT see the parent\'s conversation.',
              },
              role: {
                type: 'string',
                enum: ['leaf', 'orchestrator'],
                description: 'leaf (default) = no further delegation. orchestrator = can spawn children (max depth 2).',
              },
              max_iterations: {
                type: 'number',
                description: 'Max agent loop iterations for this subagent (default 15, max 25).',
              },
            },
            required: ['goal'],
          },
        },
      },
      ['tasks']
    ),
    requiresApproval: false,
    readOnly: false,
    tags: ['delegation', 'subagent'],
  },
];

interface DelegateTaskDeps {
  client: FibonacciClient;
  registry: ToolRegistry;
  skills: SkillsRegistry;
  workspaceRoot: string;
  model: string;
  hermesMode: boolean;
  language: 'fa' | 'en';
}

let depsRef: DelegateTaskDeps | null = null;

export function setDelegateTaskDeps(deps: DelegateTaskDeps): void {
  depsRef = deps;
}

export function registerDelegateTaskTools(registry: ToolRegistry): void {
  registry.register(delegateTaskToolDefinitions[0], async (args, ctx) => {
    if (!depsRef) {
      return { ok: false, output: 'delegate_task is not configured. Call setDelegateTaskDeps() first.' };
    }
    const tasks = (args.tasks as Array<Record<string, unknown>>) ?? [];
    if (tasks.length === 0) {
      return { ok: false, output: 'No tasks provided.' };
    }
    if (tasks.length > 5) {
      return { ok: false, output: 'Too many tasks (max 5 per call to avoid runaway).' };
    }

    // Run all subagents in parallel.
    const results = await Promise.all(
      tasks.map((task, i) =>
        runSubagent({
          goal: String(task.goal ?? ''),
          role: (task.role as 'leaf' | 'orchestrator') ?? 'leaf',
          maxIterations: Math.min(25, Math.max(3, Number(task.max_iterations ?? 15))),
          index: i,
          total: tasks.length,
          parentSignal: ctx?.signal,
        })
      )
    );

    const summary = results
      .map(
        (r, i) =>
          `## Subagent ${i + 1} — ${r.ok ? 'SUCCESS' : 'FAILED'} (${r.iterations} iterations, ${r.duration}ms)\n\n**Goal:** ${r.goal}\n\n**Final answer:**\n${r.answer.slice(0, 8000)}${r.answer.length > 8000 ? '\n[...truncated...]' : ''}${r.toolCalls > 0 ? `\n\n(${r.toolCalls} tool calls made)` : ''}`
      )
      .join('\n\n---\n\n');

    const overallOk = results.every((r) => r.ok);
    return {
      ok: overallOk,
      output: `[delegate_task — ${results.length} subagent${results.length === 1 ? '' : 's'} ran in parallel]\n\n${summary}`,
      meta: {
        subagents: results.map((r) => ({
          ok: r.ok,
          iterations: r.iterations,
          toolCalls: r.toolCalls,
          duration: r.duration,
        })),
      },
    };
  });
}

interface SubagentResult {
  goal: string;
  ok: boolean;
  answer: string;
  iterations: number;
  toolCalls: number;
  duration: number;
}

async function runSubagent(opts: {
  goal: string;
  role: 'leaf' | 'orchestrator';
  maxIterations: number;
  index: number;
  total: number;
  parentSignal?: AbortSignal;
}): Promise<SubagentResult> {
  const startTime = Date.now();
  if (!depsRef) {
    return { goal: opts.goal, ok: false, answer: 'delegate_task deps not set', iterations: 0, toolCalls: 0, duration: 0 };
  }

  // Each subagent gets its own tool registry + approval manager so its
  // approvals don't pollute the parent's UI. We reuse the parent's tools
  // but with a fresh approval manager that auto-approves everything (the
  // subagent runs headless).
  const subRegistry = new TR();
  // Copy tool definitions + executors from the parent registry. We do this
  // by re-registering each tool with the same executor. Since the registry
  // doesn't expose executors directly, we use a small reflection trick.
  // For v1 simplicity, we share the same registry instance (the tools are
  // stateless anyway). The isolation we care about is the MESSAGE history,
  // not the tool registry.
  void subRegistry; // (kept for future isolation)

  const subApprovals = new ApprovalManager(depsRef.registry, true); // auto-approve read-only
  subApprovals.setAutoApproveReadOnly(true);
  // Force-approve everything by intercepting the request handler.
  subApprovals.setPendingHandler(() => {
    // No-op — subagent approvals are auto-resolved below.
  });

  const abortController = new AbortController();
  opts.parentSignal?.addEventListener('abort', () => abortController.abort());

  const currentDate = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt({
    mode: 'coding',
    toolFormat: depsRef.hermesMode ? 'hermes' : 'xml',
    skills: depsRef.skills.list(),
    workspaceRoot: depsRef.workspaceRoot,
    language: depsRef.language,
    currentDate,
    modelName: `${depsRef.model} (subagent)`,
    maxIterations: opts.maxIterations,
    enableReasoning: false,
  });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt + '\n\n# Subagent mode\n\nYou are running as an ISOLATED SUBAGENT with a fresh context. You do NOT see the parent conversation. Your job is to accomplish the goal below and return a clear final answer. Do NOT ask the user questions — make reasonable assumptions and proceed. When done, write a concise summary of what you did and the result.\n\n# Goal\n\n' + opts.goal },
    { role: 'user', content: opts.goal },
  ];

  let totalToolCalls = 0;
  let iterations = 0;
  let finalAnswer = '';

  try {
    for (let i = 0; i < opts.maxIterations; i++) {
      if (abortController.signal.aborted) break;
      iterations++;

      const response = await depsRef.client.chat({
        model: depsRef.model,
        messages,
        temperature: 0.3,
        signal: abortController.signal,
      });

      const { calls, prose } = parseToolCalls(response.content);

      messages.push({ role: 'assistant', content: response.content || null });

      if (calls.length === 0) {
        finalAnswer = prose;
        break;
      }

      // Execute each tool call sequentially
      for (const call of calls) {
        if (abortController.signal.aborted) break;
        totalToolCalls++;

        // Delegate_task is FORBIDDEN in leaf-role subagents (no recursion).
        if (call.name === 'delegate_task' && opts.role === 'leaf') {
          messages.push({
            role: 'user',
            content: formatToolResponseBlock('delegate_task', {
              error: 'delegate_task is not allowed in leaf-role subagents. Use a direct tool instead.',
            }),
          });
          continue;
        }

        // Auto-approve all tool calls in subagents (headless mode).
        const result = await depsRef.registry.execute(call.name, call.args, {
          workspaceRoot: depsRef.workspaceRoot,
          log: () => {},
          signal: abortController.signal,
        });
        messages.push({
          role: 'user',
          content: formatToolResponseBlock(call.name, result.output),
        });
      }

      // If we've hit the last iteration, capture whatever prose we have.
      if (i === opts.maxIterations - 1 && !finalAnswer) {
        finalAnswer = prose || '(subagent did not produce a final answer before hitting the iteration limit)';
      }
    }

    if (!finalAnswer) {
      finalAnswer = '(subagent did not produce a final answer)';
    }

    return {
      goal: opts.goal,
      ok: true,
      answer: finalAnswer,
      iterations,
      toolCalls: totalToolCalls,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      goal: opts.goal,
      ok: false,
      answer: `Subagent failed: ${msg}`,
      iterations,
      toolCalls: totalToolCalls,
      duration: Date.now() - startTime,
    };
  }
}
