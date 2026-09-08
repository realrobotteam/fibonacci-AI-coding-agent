/**
 * Approximate USD pricing per 1M tokens (prompt / completion) for common
 * model families. Matched by case-insensitive substring against the model id,
 * longest / most specific key first. Unknown models → null (tokens only).
 *
 * Prices are "good enough" estimates for a UI footnote; they deliberately lag
 * list prices rather than guess wrongly high.
 */
const PRICING: Array<{ match: string[]; prompt: number; completion: number }> = [
  { match: ['o1-preview'], prompt: 15, completion: 60 },
  { match: ['o1-mini'], prompt: 1.1, completion: 4.4 },
  { match: ['o1'], prompt: 15, completion: 60 },
  { match: ['o3-mini'], prompt: 1.1, completion: 4.4 },
  { match: ['o3'], prompt: 2, completion: 8 },
  { match: ['o4-mini'], prompt: 1.1, completion: 4.4 },
  { match: ['gpt-4.5'], prompt: 75, completion: 150 },
  { match: ['gpt-4.1-mini'], prompt: 0.4, completion: 1.6 },
  { match: ['gpt-4.1-nano'], prompt: 0.1, completion: 0.4 },
  { match: ['gpt-4.1'], prompt: 2, completion: 8 },
  { match: ['gpt-4o-mini'], prompt: 0.15, completion: 0.6 },
  { match: ['gpt-4o'], prompt: 2.5, completion: 10 },
  { match: ['gpt-4-turbo'], prompt: 10, completion: 30 },
  { match: ['gpt-4'], prompt: 30, completion: 60 },
  { match: ['gpt-3.5'], prompt: 0.5, completion: 1.5 },
  { match: ['claude-opus-4'], prompt: 15, completion: 75 },
  { match: ['claude-opus'], prompt: 15, completion: 75 },
  { match: ['claude-sonnet-4'], prompt: 3, completion: 15 },
  { match: ['claude-sonnet'], prompt: 3, completion: 15 },
  { match: ['claude-3-7'], prompt: 3, completion: 15 },
  { match: ['claude-3-5-sonnet', 'claude-3.5-sonnet'], prompt: 3, completion: 15 },
  { match: ['claude-haiku-4', 'claude-3-5-haiku', 'claude-3.5-haiku'], prompt: 0.8, completion: 4 },
  { match: ['claude-3-haiku'], prompt: 0.25, completion: 1.25 },
  { match: ['gemini-2.5-pro'], prompt: 1.25, completion: 10 },
  { match: ['gemini-2.5-flash'], prompt: 0.3, completion: 2.5 },
  { match: ['gemini-2.0'], prompt: 0.1, completion: 0.4 },
  { match: ['gemini-1.5-pro'], prompt: 1.25, completion: 5 },
  { match: ['gemini-1.5-flash'], prompt: 0.075, completion: 0.3 },
  { match: ['deepseek-reasoner', 'deepseek-r1'], prompt: 0.55, completion: 2.2 },
  { match: ['deepseek'], prompt: 0.27, completion: 1.1 },
  { match: ['grok-4'], prompt: 3, completion: 15 },
  { match: ['grok-3'], prompt: 3, completion: 15 },
  { match: ['grok-2'], prompt: 2, completion: 10 },
  { match: ['mistral-large'], prompt: 2, completion: 6 },
  { match: ['llama-3.3-70b'], prompt: 0.6, completion: 0.6 },
  { match: ['llama-3.1-405b'], prompt: 2.7, completion: 2.7 },
  { match: ['qwen-max'], prompt: 1.6, completion: 6.4 },
  { match: ['qwen-plus'], prompt: 0.4, completion: 1.2 },
];

/** Approximate USD cost for one turn, or undefined when pricing is unknown. */
export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number | undefined {
  const id = (modelId || '').toLowerCase();
  for (const entry of PRICING) {
    if (entry.match.some((m) => id.includes(m))) {
      return (promptTokens / 1_000_000) * entry.prompt
        + (completionTokens / 1_000_000) * entry.completion;
    }
  }
  return undefined;
}

/** Rough token estimate for plain text (≈4 chars/token, Unicode-aware floor). */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** Format a USD cost compactly: $0.0123 → "$0.0123", $3.10 → "$3.10". */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
