/**
 * Smoke tests for the Hermes template parser & renderer.
 * Run with: npx tsx scripts/test-hermes.ts
 */

import {
  parseHermesToolCalls,
  parseHermesThinking,
  formatToolResponseBlock,
  formatArgument,
  formatToolDeclaration,
  renderHermesPrompt,
  emitToolCallExample,
} from '../src/core/hermesTemplate';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log('  ✓', msg);
  } else {
    fail++;
    console.error('  ✗', msg);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. formatArgument
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] formatArgument');

assert(formatArgument('hello') === '<|"|>hello<|"|>', 'string wraps in Q tokens');
assert(formatArgument(true) === 'true', 'boolean true → "true"');
assert(formatArgument(false) === 'false', 'boolean false → "false"');
assert(formatArgument(42) === '42', 'number → string');
assert(formatArgument(null) === 'null', 'null → "null"');
assert(formatArgument([1, 'a']) === '[1,<|"|>a<|"|>]', 'array → bracketed');
// Note: formatArgument escapes keys with Q tokens when escapeKeys=true (default),
// mirroring the Jinja template's behavior.
assert(
  formatArgument({ a: 1, b: 'x' }) === '{<|"|>a<|"|>:1,<|"|>b<|"|>:<|"|>x<|"|>}',
  'object → brace-wrapped (keys escaped)'
);
// With escapeKeys=false, keys are bare (mirrors format_argument(arg, escape_keys=False))
assert(
  formatArgument({ a: 1, b: 'x' }, false) === '{a:1,b:<|"|>x<|"|>}',
  'object escapeKeys=false has bare keys'
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. parseHermesToolCalls
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] parseHermesToolCalls');

{
  const text = 'Hello\n<|tool_call>call:write_to_file{path:"index.html",content:"<h1>Hi</h1>"}<tool_call|>\nDone.';
  const { calls, prose } = parseHermesToolCalls(text);
  assert(calls.length === 1, 'one tool call parsed');
  assert(calls[0].name === 'write_to_file', 'tool name = write_to_file');
  assert(calls[0].args.path === 'index.html', 'args.path = index.html');
  assert(calls[0].args.content === '<h1>Hi</h1>', 'args.content correct');
  assert(prose.includes('Hello') && prose.includes('Done'), 'prose preserves surrounding text');
}

{
  const text = '<|tool_call>call:read_file{path:"src/index.ts"}<tool_call|>';
  const { calls } = parseHermesToolCalls(text);
  assert(calls.length === 1, 'single tool call works');
  assert(calls[0].name === 'read_file', 'name = read_file');
  assert(calls[0].args.path === 'src/index.ts', 'args.path correct');
}

{
  const text = '<|tool_call>call:read_file{path:"a.ts"}<tool_call|> middle <|tool_call>call:read_file{path:"b.ts"}<tool_call|>';
  const { calls, prose } = parseHermesToolCalls(text);
  assert(calls.length === 2, 'two tool calls parsed');
  assert(calls[0].args.path === 'a.ts' && calls[1].args.path === 'b.ts', 'both paths correct');
  assert(prose.includes('middle'), 'prose has middle text');
}

{
  // Nested objects in args
  const text = '<|tool_call>call:call_mcp_tool{server:"fs",tool:"read",args:{path:"/tmp/x"}}<tool_call|>';
  const { calls } = parseHermesToolCalls(text);
  assert(calls.length === 1, 'nested object tool call parsed');
  assert(calls[0].args.server === 'fs', 'server = fs');
  const inner = calls[0].args.args as Record<string, unknown>;
  assert(inner && inner.path === '/tmp/x', 'nested args.path = /tmp/x');
}

{
  // Array args
  const text = '<|tool_call>call:update_todos{todos:[{content:"a",status:"pending"}]}<tool_call|>';
  const { calls } = parseHermesToolCalls(text);
  assert(calls.length === 1, 'array-arg tool call parsed');
  const todos = calls[0].args.todos as Array<Record<string, unknown>>;
  assert(Array.isArray(todos) && todos.length === 1, 'todos is array of 1');
  assert(todos[0].content === 'a' && todos[0].status === 'pending', 'todos[0] fields correct');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. parseHermesThinking
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] parseHermesThinking');

{
  const text = '<|channel>thought\nLet me think about this.\n<channel|>\nNow I will act.';
  const { prose, thinking } = parseHermesThinking(text);
  assert(thinking === 'Let me think about this.', 'thinking content extracted');
  assert(prose === 'Now I will act.', 'prose excludes thinking');
}

{
  const text = 'No thinking here, just prose.';
  const { prose, thinking } = parseHermesThinking(text);
  assert(thinking === '', 'no thinking → empty');
  assert(prose === 'No thinking here, just prose.', 'prose preserved');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. formatToolResponseBlock
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] formatToolResponseBlock');

{
  const out = formatToolResponseBlock('read_file', 'file contents here');
  assert(out.startsWith('<|tool_response>response:read_file{value:'), 'response opens correctly');
  assert(out.endsWith('<tool_response|>'), 'response closes with <tool_response|>');
  assert(out.includes('file contents here'), 'response body included');
}

{
  const out = formatToolResponseBlock('foo', { ok: true, count: 5 });
  assert(out.includes('ok:true'), 'object response has ok:true');
  assert(out.includes('count:5'), 'object response has count:5');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. formatToolDeclaration
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] formatToolDeclaration');

{
  const tool: ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'write_to_file',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  };
  const out = formatToolDeclaration(tool);
  assert(out.startsWith('declaration:write_to_file{description:'), 'declaration starts correctly');
  assert(out.includes('parameters:'), 'declaration has parameters');
  assert(out.includes('required:['), 'declaration has required');
  assert(out.includes('type:<|"|>OBJECT<|"|>'), 'declaration has OBJECT type');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. renderHermesPrompt
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] renderHermesPrompt');

{
  const out = renderHermesPrompt(
    [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Hello' },
    ],
    [],
    { addGenerationPrompt: false }
  );
  assert(out.includes('<|begin_of_text|>'), 'has BOS token');
  assert(out.includes('<|turn>system\n'), 'has system turn');
  assert(out.includes('You are an agent.'), 'system content included');
  assert(out.includes('<|turn>user\n'), 'has user turn');
  assert(out.includes('Hello'), 'user content included');
}

{
  const out = renderHermesPrompt(
    [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Hi' },
    ],
    [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path' } },
            required: ['path'],
          },
        },
      },
    ],
    { addGenerationPrompt: true }
  );
  assert(out.includes('<|tool>declaration:read_file'), 'has tool declaration');
  assert(out.includes('<tool|>'), 'tool declaration closed');
  assert(out.includes('<|turn>model\n'), 'has model generation prompt');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. emitToolCallExample
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] emitToolCallExample');

{
  const out = emitToolCallExample('read_file', { path: 'index.html' });
  assert(out === '<|tool_call>call:read_file{path:<|"|>index.html<|"|>}<tool_call|>', 'example matches expected');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
