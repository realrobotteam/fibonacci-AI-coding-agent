import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Trim the API message array to stay within a character budget (~30K tokens).
 *
 * Rules:
 *   1. Never drop or truncate the system prompt — but it COUNTS toward the
 *      budget (previously it was excluded, so the wire payload could exceed
 *      the budget by the full system-prompt size).
 *   2. Compress old tool-result messages into short stubs — they're the
 *      biggest culprits (full file content embedded in tool output).
 *   3. If still over budget, drop oldest messages — together with any tool
 *      results they spawned — preserving the last `keepRecent` messages so
 *      the model retains immediate context.
 *   4. Last resort: hard-truncate individual oversized messages (never the
 *      system prompt) so even a single huge message inside the recent window
 *      cannot push the payload over budget.
 *
 * Tool results travel as `role:'user'` messages in production (Hermes
 * `<|tool_response>response:name{...}` blocks or the legacy
 * `[Tool result for name]` text format), so detection is marker-based;
 * legacy `role:'tool'` rows are still accepted.
 *
 * GUARANTEED TERMINATION: every loop strictly reduces either the total
 * payload length or the message count, and each loop is additionally capped.
 * (The previous implementation could infinite-loop: it re-inserted an
 * eviction notice at the front of the array on EVERY iteration and then
 * shifted that same notice out again on the next one, so neither the total
 * length nor the array length ever decreased — freezing the extension host
 * the moment a long conversation crossed the budget.)
 *
 * Extracted from agentLoop.ts as a pure, VS Code-free function so it can be
 * unit-tested directly.
 */

const NOTICE = '[an older message was dropped from context to fit budget]';
const TRUNCATED_SUFFIX = '\n[...truncated to fit context budget...]';
const HERMES_TOOL_RESP_OPEN = '<|tool_response>';
const XML_TOOL_RESP_OPEN = '[Tool result for ';
const STUB_FLOOR = 200; // only stub tool results larger than this
const TRUNCATE_FLOOR = 500; // never truncate a message below this size
const MAX_GUARD = 10_000; // absolute iteration cap (defense in depth)

interface ToolResultInfo {
  name: string;
}

function asString(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

function msgLen(m: ChatCompletionMessageParam): number {
  return asString(m.content).length;
}

/**
 * Detect a tool-result message and extract the tool name (best effort).
 * Production wire format is `role:'user'` with a Hermes `<|tool_response>`
 * or legacy `[Tool result for name]` text prefix; `role:'tool'` rows are
 * accepted for backwards compatibility.
 */
function detectToolResult(m: ChatCompletionMessageParam): ToolResultInfo | null {
  if (m.role === 'tool') {
    const name = (m as { toolName?: string }).toolName;
    return { name: typeof name === 'string' && name.length > 0 ? name : 'tool' };
  }
  if (m.role !== 'user') return null;
  const content = asString(m.content);
  if (content.startsWith(HERMES_TOOL_RESP_OPEN)) {
    // <|tool_response>response:name{...}<tool_response|>
    const match = content.match(/^<\|tool_response>\s*response:([\w.:-]+)/);
    return { name: match ? match[1] : 'tool' };
  }
  if (content.startsWith(XML_TOOL_RESP_OPEN)) {
    // [Tool result for name]\n...
    const match = content.match(/^\[Tool result for ([\w.:-]+)\]/);
    return { name: match ? match[1] : 'tool' };
  }
  return null;
}

export function enforceBudget(
  messages: ChatCompletionMessageParam[],
  budget: number,
  keepRecent: number
): ChatCompletionMessageParam[] {
  const totalLen0 = messages.reduce((n, m) => n + msgLen(m), 0);
  if (totalLen0 <= budget) return messages;

  // Split off the (first) system prompt. It counts toward the budget but is
  // never dropped, stubbed or truncated.
  const result: ChatCompletionMessageParam[] = [];
  let system: ChatCompletionMessageParam | undefined;
  let total = 0;
  for (const m of messages) {
    if (m.role === 'system' && !system) {
      system = m;
    } else {
      result.push(m);
      total += msgLen(m);
    }
  }

  // The system prompt shares the budget; keep a minimal floor so that a
  // pathologically huge system prompt cannot force an empty payload.
  const effectiveBudget = Math.max(
    TRUNCATE_FLOOR,
    budget - (system ? msgLen(system) : 0)
  );

  // Pass 1: compress oversized tool results that are older than the recent
  // window (they are the biggest culprits — full file content, web pages…).
  const protectedFrom = Math.max(0, result.length - keepRecent);
  for (let i = 0; i < protectedFrom; i++) {
    if (total <= effectiveBudget) break;
    const info = detectToolResult(result[i]);
    if (!info) continue;
    const len = msgLen(result[i]);
    if (len <= STUB_FLOOR) continue;
    const stub =
      `[tool result for ${info.name} dropped from context to fit budget — ` +
      `${len.toLocaleString()} chars removed]`;
    total += stub.length - len;
    result[i] = { role: 'user', content: stub } as ChatCompletionMessageParam;
  }

  // Pass 2: drop oldest messages entirely if still over budget, keeping at
  // least `keepRecent`. Each dropped assistant turn orphans the tool-result
  // messages that immediately follow it, so those are dropped together (the
  // model must never see a tool result whose tool call is gone).
  //
  // The eviction notice is inserted ONCE, after the drops, with its cost
  // pre-accounted in the loop condition — never re-inserted per iteration
  // (the previous per-iteration unshift is what made this loop spin forever).
  let dropped = false;
  let guard = 0;
  while (
    result.length > keepRecent &&
    total + NOTICE.length > effectiveBudget &&
    guard++ < MAX_GUARD
  ) {
    dropped = true;
    const removed = result.shift()!;
    total -= msgLen(removed);
    while (
      result.length > keepRecent &&
      detectToolResult(result[0]) !== null &&
      guard++ < MAX_GUARD
    ) {
      total -= msgLen(result.shift()!);
    }
  }
  if (dropped) {
    result.unshift({ role: 'user', content: NOTICE } as ChatCompletionMessageParam);
    total += NOTICE.length;
  }

  // Pass 3 (last resort): the recent window itself can still exceed the
  // budget (e.g. a single 500K-char user paste or a giant tool result inside
  // the last `keepRecent` messages — Pass 1/2 deliberately never touch it).
  // Hard-truncate the tail of individual oversized messages, oldest first.
  // The system prompt is exempt. Terminates: each index is truncated at most
  // once and every truncation strictly reduces `total`.
  for (
    let i = 0;
    i < result.length && total > effectiveBudget && guard++ < MAX_GUARD;
    i++
  ) {
    const len = msgLen(result[i]);
    // The suffix itself costs chars — only worth truncating if there is
    // meaningful content to cut (otherwise the payload would GROW).
    if (len <= TRUNCATE_FLOOR + TRUNCATED_SUFFIX.length) continue;
    const keep = Math.max(
      TRUNCATE_FLOOR,
      len - (total - effectiveBudget) - TRUNCATED_SUFFIX.length
    );
    const truncated = asString(result[i].content).slice(0, keep) + TRUNCATED_SUFFIX;
    total += truncated.length - len;
    result[i] = {
      role: result[i].role,
      content: truncated,
    } as ChatCompletionMessageParam;
  }

  if (system) result.unshift(system);
  return result;
}
