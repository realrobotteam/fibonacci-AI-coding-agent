// Naive line-diff for the approval dialog's inline preview.
// Plain LCS DP — O(n*m) is fine up to the guard below; beyond it we fall back
// to a cheap multiset count summary instead of a per-line diff.

export interface DiffLine {
  type: 'add' | 'del' | 'same';
  text: string;
}

export interface LineDiff {
  /** Per-line result (empty when `truncated`). */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when input exceeded the LCS size guard — no per-line diff available. */
  truncated: boolean;
}

/** Max lines per side for the O(n*m) LCS pass. */
const MAX_LCS_LINES = 500;

export function diffLines(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    // Fallback: multiset line count — cheap O(n+m) approximation of +/− counts.
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of b) {
      const c = counts.get(line) ?? 0;
      if (c > 0) counts.set(line, c - 1);
      else added++;
    }
    let removed = 0;
    for (const c of counts.values()) removed += c;
    return { lines: [], added, removed, truncated: true };
  }

  const n = a.length;
  const m = b.length;
  // LCS length table, rolling rows to keep memory at O(m).
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to emit the edit script (then reverse).
  const lines: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lines.push({ type: 'same', text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      lines.push({ type: 'del', text: a[i - 1] });
      i--;
    } else {
      lines.push({ type: 'add', text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    lines.push({ type: 'del', text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    lines.push({ type: 'add', text: b[j - 1] });
    j--;
  }
  lines.reverse();

  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  return { lines, added, removed, truncated: false };
}

/**
 * The first `max` changed (+/−) lines of a diff, in order — used for the
 * compact inline preview.
 */
export function firstChangedLines(lines: DiffLine[], max: number): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of lines) {
    if (line.type !== 'same') {
      out.push(line);
      if (out.length >= max) break;
    }
  }
  return out;
}
