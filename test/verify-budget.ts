/* Standalone adversarial harness for enforceBudget (Task 14 verification). */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { enforceBudget } from '../src/core/contextBudget';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const len = (m: ChatCompletionMessageParam) => (typeof m.content === 'string' ? m.content.length : 0);
const total = (ms: ChatCompletionMessageParam[]) => ms.reduce((n, m) => n + len(m), 0);

// 1. THE REGRESSION: production wire format (all role 'user'/'assistant', NO
// role:'tool') over budget — previously infinite-looped (host freeze).
{
  const msgs: ChatCompletionMessageParam[] = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: 'u'.repeat(9000) });
    msgs.push({ role: 'assistant', content: 'a'.repeat(9000) });
  }
  const out = enforceBudget(msgs, 120_000, 6);
  check('1a. all-user over budget terminates (was infinite loop)', true);
  check('1b. result within budget', total(out) <= 120_000, `total=${total(out)}`);
  check('1c. system preserved first', out[0].role === 'system' && out[0].content === 'S');
  check('1d. recent window survives', len(out[out.length - 1]) > 0);
}

// 2. Legacy role:'tool' rows are still stubbed (existing-test semantics).
{
  const big = 'x'.repeat(500);
  const msgs = [
    { role: 'user', content: 'a'.repeat(10) },
    { role: 'tool', content: big },
    { role: 'user', content: 'recent' },
  ] as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 200, 1);
  check('2a. stub inserted', out.some((m) => String(m.content).includes('dropped from context')));
  check('2b. recent survives', out[out.length - 1].content === 'recent');
}

// 3. Hermes wire-format tool results get stubbed with the tool name.
{
  const msgs = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'calling tool' },
    { role: 'user', content: '<|tool_response>response:read_file{value:"' + 'f'.repeat(5000) + '"}' },
    { role: 'user', content: 'next step' },
  ] as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 1000, 1);
  const stub = out.find((m) => String(m.content).includes('dropped from context'));
  check('3a. hermes tool result stubbed', !!stub);
  check('3b. tool name extracted', !!stub && String(stub.content).includes('read_file'), String(stub?.content));
}

// 4. Legacy XML format detected.
{
  const msgs = [
    { role: 'user', content: 'a'.repeat(10) },
    { role: 'user', content: '[Tool result for write_to_file]\n' + 'w'.repeat(5000) },
    { role: 'user', content: 'tail' },
  ] as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 1000, 1);
  const stub = out.find((m) => String(m.content).includes('dropped from context'));
  check('4. xml tool result stubbed with name', !!stub && String(stub.content).includes('write_to_file'));
}

// 5. Giant single message inside the recent window → Pass 3 hard truncation.
{
  const msgs: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'S'.repeat(1000) },
    { role: 'user', content: 'P'.repeat(500_000) },
  ];
  const out = enforceBudget(msgs, 120_000, 6);
  check('5a. giant recent message truncated to budget', total(out) <= 120_000, `total=${total(out)}`);
  check('5b. truncation marker present', out.some((m) => String(m.content).includes('truncated to fit context budget')));
  check('5c. system intact', out[0].content === 'S'.repeat(1000));
}

// 6. System prompt counts toward the budget.
{
  const msgs: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'S'.repeat(20_000) },
    { role: 'user', content: 'u'.repeat(105_000) },
  ];
  const out = enforceBudget(msgs, 120_000, 6);
  check('6. payload (incl. system) within budget', total(out) <= 120_000, `total=${total(out)}`);
}

// 7. Orphan rule: dropping an assistant turn drops its tool results too.
{
  const msgs: ChatCompletionMessageParam[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'a'.repeat(100) },
    { role: 'user', content: '<|tool_response>response:run_command{value:"ok"}' },
    { role: 'user', content: 'final question' },
  ] as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 150, 1);
  const first = out[0].role === 'system' ? out[1] : out[0];
  check(
    '7. no orphaned tool result at front',
    !(typeof first.content === 'string' && first.content.startsWith('<|tool_response>')),
    String(first.content).slice(0, 60)
  );
}

// 8. Under budget → same reference returned.
{
  const msgs = [{ role: 'user', content: 'hi' }] as ChatCompletionMessageParam[];
  check('8. under budget returns identity', enforceBudget(msgs, 1000, 1) === msgs);
}

// 9. Pathological: many empty-ish messages over budget (length must decrease).
{
  const msgs: ChatCompletionMessageParam[] = Array.from({ length: 50 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: i < 45 ? 'x' : 'y'.repeat(90_000),
  })) as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 120_000, 6);
  check('9a. pathological case terminates', true);
  check('9b. within budget', total(out) <= 120_000, `total=${total(out)}`);
}

// 10. Replicate tools.test.ts case 3 (system kept first, aggressive budget).
{
  const sys = { role: 'system', content: 'sys' } as ChatCompletionMessageParam;
  const msgs = [
    sys,
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'tool', content: 'y'.repeat(400) },
    { role: 'user', content: 'z' },
  ] as ChatCompletionMessageParam[];
  const out = enforceBudget(msgs, 100, 1);
  check('10. system message kept first', out[0].role === 'system' && out[0].content === 'sys');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
