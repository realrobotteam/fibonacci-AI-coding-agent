import { describe, it, expect } from 'vitest';
import { parseToolCalls } from '../src/core/toolParser';
import {
  formatToolResponseBlock,
  formatToolDeclaration,
  parseHermesThinking,
} from '../src/core/hermesTemplate';

describe('parseToolCalls — XML format', () => {
  it('parses a simple write_to_file call', () => {
    const text = 'Here you go.\n<write_to_file>\n<path>index.html</path>\n<content>hello</content>\n</write_to_file>';
    const { calls, prose } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_to_file');
    expect(calls[0].args.path).toBe('index.html');
    expect(calls[0].args.content).toBe('hello');
    expect(prose).not.toContain('<write_to_file>');
    expect(prose).toContain('Here you go.');
  });

  it('strips incomplete blocks while streaming', () => {
    const text = 'Working on it…\n<write_to_file>\n<path>a.py</path>\n<content>print(1)';
    const { calls, prose } = parseToolCalls(text, { streaming: true });
    expect(calls).toHaveLength(0);
    expect(prose).not.toContain('<write_to_file>');
  });

  it('ignores unknown tags (treats as prose)', () => {
    const text = 'Use <b>bold</b> tags.';
    const { calls, prose } = parseToolCalls(text);
    expect(calls).toHaveLength(0);
    expect(prose).toContain('<b>');
  });

  it('parses JSON-ish param values', () => {
    const text = '<update_todos>\n<todos>[{"content":"a","status":"pending"}]</todos>\n</update_todos>';
    const { calls } = parseToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0].args.todos)).toBe(true);
  });
});

describe('parseHermesThinking', () => {
  it('extracts the thought channel and strips it from prose', () => {
    const text = '<|channel>thought\nI should create a file.\n<channel|>\nDone!';
    const { prose, thinking } = parseHermesThinking(text);
    expect(thinking).toBe('I should create a file.');
    expect(prose).toBe('Done!');
  });

  it('returns empty thinking when no channel present', () => {
    const { thinking } = parseHermesThinking('just prose');
    expect(thinking).toBe('');
  });
});

describe('hermesTemplate formatting', () => {
  it('formats a tool response block with escaped value', () => {
    const block = formatToolResponseBlock('read_file', 'some "quoted" content');
    expect(block).toContain('response:read_file{value:');
    expect(block).toContain('\\"quoted\\"');
    expect(block.startsWith('<|tool_response>')).toBe(true);
    expect(block.endsWith('<tool_response|>')).toBe(true);
  });

  it('does not emit a leading comma for schema-less parameters', () => {
    const decl = formatToolDeclaration({
      type: 'function',
      function: {
        name: 'think',
        description: 'scratchpad',
        parameters: {
          type: 'object',
          properties: { thought: { type: 'string' } },
          required: ['thought'],
        },
      },
    } as never);
    expect(decl).not.toContain('{,type:');
    expect(decl).not.toContain(',{,');
    expect(decl).toContain('thought:{type:"STRING"}');
  });
});
