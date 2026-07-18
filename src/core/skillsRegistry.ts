/**
 * Skills registry.
 *
 * A Skill is a higher-level reusable prompt pattern that the agent can invoke.
 * Skills wrap a multi-step procedure with explicit preconditions and a
 * step-by-step body. Inspired by Hermes Agent's skills system.
 *
 * Skills are NOT tools — they don't execute code. Instead, when invoked, their
 * body is injected into the conversation as an assistant-side procedure note,
 * guiding the model through a known pattern. This is cheaper than a sub-agent
 * and more flexible than a hardcoded tool.
 */

import type { SkillDefinition } from '../types';
import type { ToolRegistry } from './toolRegistry';

export class SkillsRegistry {
  private skills = new Map<string, SkillDefinition>();
  private onChangeHandlers: Array<(skills: SkillDefinition[]) => void> = [];

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    this.emit();
  }

  unregister(name: string): void {
    this.skills.delete(name);
    this.emit();
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  list(category?: string): SkillDefinition[] {
    const all = Array.from(this.skills.values());
    return category ? all.filter((s) => s.category === category) : all;
  }

  /** List only skills whose required tools are all available. */
  listAvailable(registry: ToolRegistry, category?: string): SkillDefinition[] {
    return this.list(category).filter((s) => {
      if (!s.requiredTools || s.requiredTools.length === 0) return true;
      return s.requiredTools.every((t) => registry.has(t));
    });
  }

  onChange(fn: (skills: SkillDefinition[]) => void): void {
    this.onChangeHandlers.push(fn);
  }

  private emit(): void {
    const list = this.list();
    this.onChangeHandlers.forEach((fn) => fn(list));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in skills
// ─────────────────────────────────────────────────────────────────────────────

export const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    name: 'debug-error',
    description: 'Systematically debug an error: reproduce, isolate, fix, verify.',
    category: 'debug',
    requiredTools: ['read_file', 'grep_search', 'diagnostics', 'execute_command'],
    triggers: ['error', 'bug', 'not working', 'fails', 'exception', 'خطا', 'ارور', 'باگ'],
    body: `# Debug procedure

When debugging an error, follow this sequence:

1. **Reproduce** — Run the failing command/test to confirm the error and capture the exact message.
2. **Locate** — Use grep_search to find the file(s) and line(s) referenced in the stack trace or error message.
3. **Read** — Use read_file to read the relevant code with enough surrounding context (5+ lines before and after).
4. **Diagnose** — Use the think tool to reason about the root cause. List 2-3 candidate causes, then pick the most likely.
5. **Fix** — Use replace_in_file to apply the smallest possible fix. Do not refactor unrelated code.
6. **Verify** — Re-run the command/test. If it passes, mark the todo complete. If it still fails, go back to step 3.
7. **Report** — Tell the user in Persian what the root cause was and what you changed.

Rules:
- Do NOT skip the Reproduce step. Reading the error message secondhand is not enough.
- Do NOT fix symptoms. Find the root cause.
- If you cannot reproduce the error, ask the user for the exact steps.`,
  },
  {
    name: 'refactor-extract',
    description: 'Extract a function/method from duplicated or inline code.',
    category: 'refactor',
    requiredTools: ['read_file', 'grep_search', 'replace_in_file', 'diagnostics'],
    triggers: ['refactor', 'extract', 'duplicate', 'DRY', 'بازنویسی', 'ریفتور'],
    body: `# Extract-function refactor procedure

1. **Find duplicates** — Use grep_search to find all occurrences of the code pattern you want to extract.
2. **Read context** — Use read_file to read 10+ lines around each occurrence.
3. **Design signature** — Use think to design the function signature: name, parameters, return type. Aim for the smallest possible parameter list.
4. **Create the function** — Use write_to_file or replace_in_file to add the new function near its first caller.
5. **Replace each occurrence** — Use replace_in_file to replace each duplicate with a call to the new function. Do them one at a time.
6. **Verify** — Run diagnostics on every changed file. If any errors, fix immediately.
7. **Report** — Tell the user in Persian what was extracted, where the new function lives, and how many call sites were updated.`,
  },
  {
    name: 'write-tests',
    description: 'Write a test suite for a function, module, or component.',
    category: 'test',
    requiredTools: ['read_file', 'grep_search', 'write_to_file', 'execute_command'],
    triggers: ['test', 'spec', 'coverage', 'تست', 'آزمون'],
    body: `# Test-writing procedure

1. **Read the code under test** — Use read_file to read the full implementation. Note the public API (exported functions/classes) and edge cases.
2. **Find existing tests** — Use grep_search for the test pattern (describe, it, test, def test_) to understand the existing test style.
3. **Identify the test framework** — Read package.json / pyproject.toml / etc. to confirm the framework (jest, vitest, pytest, etc.).
4. **List cases** — Use think to enumerate test cases: happy path, edge cases (empty input, null, very large), error cases, boundary conditions.
5. **Write the test file** — Use write_to_file to create the test file. Use the existing test style. Cover all cases from step 4.
6. **Run the tests** — Use execute_command to run the new tests. They should all pass.
7. **Check coverage** — If a coverage tool is configured, run it and report the delta.
8. **Report** — Tell the user in Persian how many tests were added, what they cover, and the test command.`,
  },
  {
    name: 'explain-code',
    description: 'Explain a codebase, file, or function in Persian.',
    category: 'explain',
    requiredTools: ['read_file', 'grep_search', 'document_symbols'],
    triggers: ['explain', 'understand', 'how does', 'what does', 'توضیح', 'چطور', 'چیست'],
    body: `# Code explanation procedure

1. **Get the structure** — Use document_symbols to get the high-level structure (classes, functions, exports) of the file(s).
2. **Read the code** — Use read_file to read the file in full. If large, read it in sections.
3. **Find entry points** — Use grep_search to find where the code is imported/used. This reveals its purpose in the larger system.
4. **Identify patterns** — Note any design patterns (factory, observer, etc.), frameworks, or notable libraries.
5. **Explain in Persian** — Write a structured explanation in Persian:
   - هدف کلی (overall purpose)
   - ساختار (structure: classes, functions, their relationships)
   - نحوه استفاده (how it's used: entry points, callers)
   - نکات مهم (notable points: patterns, gotchas, dependencies)
6. **Use code references** — When mentioning specific lines, use the format \`file.ts:LINE\` so the user can jump to them.`,
  },
  {
    name: 'plan-feature',
    description: 'Plan a new feature: research, design, list files to change.',
    category: 'plan',
    requiredTools: ['read_file', 'grep_search', 'list_files', 'think'],
    triggers: ['plan', 'design', 'implement feature', 'add feature', 'برنامه', 'طراحی', 'پیاده‌سازی'],
    body: `# Feature planning procedure

1. **Understand the request** — Use think to restate the feature in your own words. List the user's explicit requirements and your inferred requirements.
2. **Survey the codebase** — Use list_files and grep_search to find related code. Read the most relevant files with read_file.
3. **Identify integration points** — Where does the new code plug in? What existing functions/classes will be extended or called?
4. **Design the API** — Use think to sketch the new functions/classes/types. Aim for minimal surface area.
5. **List the changes** — Produce a structured plan in Persian:
   - فایل‌های جدید (new files to create, with one-line purpose each)
   - فایل‌های تغییر یافته (existing files to modify, with what changes)
   - وابستگی‌ها (new dependencies, if any)
   - ریسک‌ها (risks: breaking changes, performance, security)
   - مراحل اجرا (execution steps in order)
6. **Estimate effort** — Give a rough effort estimate per step (S/M/L).
7. **Ask for confirmation** — End by asking the user if they want to proceed (or use request_mode_switch to coding mode if currently in plan mode).`,
  },
  {
    name: 'safe-edit',
    description: 'Edit an existing file safely: read, locate, edit, verify.',
    category: 'general',
    requiredTools: ['read_file', 'replace_in_file', 'diagnostics'],
    triggers: ['edit', 'change', 'modify', 'update', 'ویرایش', 'تغییر', 'اصلاح'],
    body: `# Safe-edit procedure

1. **Read first** — ALWAYS read the file with read_file before editing. Do not edit blind.
2. **Locate exact text** — Identify the exact text you want to change. Note surrounding context (3-5 lines) to make the SEARCH block unique.
3. **Write the SEARCH/REPLACE** — Construct the diff carefully:
   - SEARCH must match EXACTLY (whitespace, indentation, quotes).
   - REPLACE contains the new text.
   - If making multiple edits in the same file, chain multiple blocks.
4. **Apply with replace_in_file** — Use replace_in_file (NOT write_to_file) for edits.
5. **Verify** — Read the file back. Run diagnostics. If anything is off, fix immediately.
6. **Report** — Tell the user in Persian what was changed and where.

Rules:
- NEVER use write_to_file to edit an existing file unless you intend a full rewrite.
- NEVER guess the file's current contents — always read first.
- If the SEARCH block fails, re-read the file (it may have changed) and retry.`,
  },
];

export function registerBuiltInSkills(registry: SkillsRegistry): void {
  for (const skill of BUILT_IN_SKILLS) {
    registry.register(skill);
  }
}
