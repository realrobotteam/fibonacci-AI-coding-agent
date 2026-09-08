import { describe, it, expect } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { enforceBudget } from '../src/core/contextBudget';
import { applySearchReplace } from '../src/core/searchReplace';
import { isPrivateIpv4Literal, isPrivateIpv6Literal } from '../src/tools/webTools';

function userMsg(content: string): ChatCompletionMessageParam {
  return { role: 'user', content } as ChatCompletionMessageParam;
}

describe('enforceBudget', () => {
  it('returns messages unchanged when under budget', () => {
    const msgs = [userMsg('short'), userMsg('also short')];
    expect(enforceBudget(msgs, 1000, 1)).toBe(msgs);
  });

  it('compresses oversized tool results before dropping messages', () => {
    const big = 'x'.repeat(500);
    const msgs = [
      userMsg('a'.repeat(10)),
      { role: 'tool', content: big } as ChatCompletionMessageParam,
      userMsg('recent'),
    ];
    const result = enforceBudget(msgs, 200, 1);
    expect(result.some((m) => String(m.content).includes('dropped from context'))).toBe(true);
    // Recent message must survive.
    expect(result[result.length - 1].content).toBe('recent');
    // System prompt would be preserved if present — none here, fine.
  });

  it('always keeps the system message first', () => {
    const sys = { role: 'system', content: 'sys' } as ChatCompletionMessageParam;
    const msgs = [
      sys,
      userMsg('x'.repeat(400)),
      { role: 'tool', content: 'y'.repeat(400) } as ChatCompletionMessageParam,
      userMsg('z'),
    ];
    const result = enforceBudget(msgs, 100, 1);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('sys');
  });
});

describe('applySearchReplace (filePreview)', () => {
  it('applies a single SEARCH/REPLACE block', () => {
    const original = 'function hello() {\n  return 1;\n}\n';
    const diff =
      '<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE';
    expect(applySearchReplace(original, diff)).toBe('function hello() {\n  return 2;\n}\n');
  });

  it('normalizes CRLF originals so \\n SEARCH blocks match', () => {
    const original = 'a\r\nb\r\nc\r\n';
    const diff = '<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE';
    expect(applySearchReplace(original, diff)).toBe('a\nB\nc\n');
  });

  it('refuses ambiguous SEARCH blocks that match multiple locations', () => {
    const original = 'dup\ndup\ndup\n';
    const diff = '<<<<<<< SEARCH\ndup\n=======\nX\n>>>>>>> REPLACE';
    expect(() => applySearchReplace(original, diff)).toThrow(/must be unique/i);
  });

  it('throws when the SEARCH block is absent', () => {
    const diff = '<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE';
    expect(() => applySearchReplace('abc', diff)).toThrow(/not found/);
  });
});

describe('SSRF private-IP detection (webTools)', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['169.254.169.254', true],
    ['0.1.2.3', true],
    ['100.64.0.1', true],
    ['224.0.0.1', true],
    ['2130706433', true], // decimal for 127.0.0.1
    ['0x7f000001', true], // hex for 127.0.0.1
    ['0x7f.0.0.1', true], // mixed radix
  ])('%s → blocked', (host, expected) => {
    expect(isPrivateIpv4Literal(host)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['172.32.0.1', false],
    ['fibonacci.monster', false],
  ])('%s → allowed', (host, expected) => {
    expect(isPrivateIpv4Literal(host)).toBe(expected);
  });

  it.each([
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['ff02::1', true],
    ['::ffff:127.0.0.1', true],
  ])('%s → blocked', (host, expected) => {
    expect(isPrivateIpv6Literal(host)).toBe(expected);
  });

  it('allows public IPv6', () => {
    expect(isPrivateIpv6Literal('2607:f8b0:4004:800::200e')).toBe(false);
  });
});
