import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SubtaskInfo, ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';
import { FibonacciClient } from '../api/fibonacciClient';
import { ApprovalManager, describeToolCall } from '../core/approvalManager';
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
  /** FIX (approval bypass): subagents route approval-requiring tools here. */
  approvals?: ApprovalManager;
  /** Subtask-board lifecycle stream (running/done/failed per subagent).
   *  Best-effort: consumers must never break the delegation. */
  onSubtaskEvent?: (evt: SubtaskInfo) => void;
}

let depsRef: DelegateTaskDeps | null = null;

/** FIX (runaway recursion): global depth of currently-running subagents. */
const MAX_SUBAGENT_DEPTH = 2;
let activeSubagentDepth = 0;

export function setDelegateTaskDeps(deps: DelegateTaskDeps): void {
  depsRef = deps;
}

/**
 * Fire a subtask-board lifecycle event (wave 20). Non-fatal by design: the
 * board is cosmetic, so a broken consumer must never fail the delegation.
 */
function emitSubtaskEvent(deps: DelegateTaskDeps, evt: SubtaskInfo): void {
  if (!deps.onSubtaskEvent) return;
  try {
    deps.onSubtaskEvent(evt);
  } catch {
    // Non-fatal by design.
  }
}

/** Single-line, length-capped text for board cells (strip newlines, cap). */
function boardLine(s: string, cap: number): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, cap);
}

export function registerDelegateTaskTools(registry: ToolRegistry): void {
  registry.register(delegateTaskToolDefinitions[0], async (args, ctx) => {
    if (!depsRef) {
      return { ok: false, output: 'delegate_task is not configured. Call setDelegateTaskDeps() first.' };
    }
    // Capture the deps snapshot for this execution — the closure callbacks
    // below must emit to the SAME deps even if setDelegateTaskDeps() swaps
    // the module ref mid-run (e.g. onModelChanged refresh).
    const deps = depsRef;
    const tasks = (args.tasks as Array<Record<string, unknown>>) ?? [];
    if (tasks.length === 0) {
      return { ok: false, output: 'No tasks provided.' };
    }
    if (tasks.length > 5) {
      return { ok: false, output: 'Too many tasks (max 5 per call to avoid runaway).' };
    }

    // FIX (runaway recursion): enforce a hard global depth limit so
    // orchestrator chains can't spawn subagents indefinitely.
    if (activeSubagentDepth >= MAX_SUBAGENT_DEPTH) {
      return {
        ok: false,
        output: `delegate_task refused: maximum nesting depth (${MAX_SUBAGENT_DEPTH}) reached. Complete the work directly with tools instead of spawning more subagents.`,
      };
    }

    // Run all subagents in parallel.
    activeSubagentDepth++;
    let results: SubagentResult[];
    try {
      results = await Promise.all(
        tasks.map((task, i) => {
          const goal = String(task.goal ?? '');
          const role = (task.role as 'leaf' | 'orchestrator') ?? 'leaf';
          const maxIterations = Math.min(25, Math.max(3, Number(task.max_iterations ?? 15)));
          const subtaskId = `sub-${i}-${Date.now().toString(36)}`;
          const boardGoal = boardLine(goal, 200);
          // Subtask board: announce 'running' right BEFORE the subagent starts.
          emitSubtaskEvent(deps, {
            id: subtaskId,
            goal: boardGoal,
            role,
            status: 'running',
          });
          return runSubagent({
            goal,
            role,
            maxIterations,
            index: i,
            total: tasks.length,
            parentSignal: ctx?.signal,
          })
            .then((r) => {
              emitSubtaskEvent(
                deps,
                r.ok
                  ? {
                      id: subtaskId,
                      goal: boardGoal,
                      role,
                      status: 'done',
                      iterations: r.iterations,
                      durationMs: r.duration,
                      answer: boardLine(r.answer, 300),
                    }
                  : {
                      id: subtaskId,
                      goal: boardGoal,
                      role,
                      status: 'failed',
                      iterations: r.iterations,
                      durationMs: r.duration,
                      error: boardLine(r.answer, 200),
                    }
              );
              return r;
            })
            .catch((err) => {
              // Emit 'failed' on rejection too (runSubagent rarely rejects —
              // it catches internally — but never lose a board cell).
              const msg = err instanceof Error ? err.message : String(err);
              emitSubtaskEvent(deps, {
                id: subtaskId,
                goal: boardGoal,
                role,
                status: 'failed',
                error: boardLine(msg, 200),
              });
              throw err;
            });
        })
      );
    } finally {
      activeSubagentDepth--;
    }

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

  // FIX (dead code): the previously-constructed isolated registry and
  // auto-approving ApprovalManager were never used — removed. Subagents now
  // share the parent registry but route approval-requiring tools through the
  // parent's real ApprovalManager so the user still sees confirmation dialogs.

  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true });

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

        // FIX (approval bypass): route approval-requiring tools through the
        // parent's real ApprovalManager so the user sees a confirmation
        // dialog — subagents are no longer silently auto-approved.
        const toolDef = depsRef.registry.get(call.name)?.definition;
        if (depsRef.approvals && (toolDef?.requiresApproval ?? true)) {
          const approval = await depsRef.approvals.requestApproval({
            toolName: call.name,
            args: call.args,
            description: describeToolCall(call.name, call.args),
          });
          if (!approval.approved) {
            messages.push({
              role: 'user',
              content: formatToolResponseBlock(call.name, {
                error: 'The user rejected this operation. Choose a different approach or finish with what you have.',
              }),
            });
            continue;
          }
        }

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
  } finally {
    // FIX (listener leak): always detach from the parent signal.
    opts.parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
