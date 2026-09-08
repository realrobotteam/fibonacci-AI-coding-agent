import React from 'react';

/**
 * Lightweight dependency-free syntax highlighter for the Kilo-style tool
 * call code view. Produces React spans (never HTML strings) so file content
 * can't inject markup. Colors come from VS Code theme variables
 * (--vscode-charts-*) so they adapt to the user's light/dark theme.
 *
 * Supported families:
 *   - js/ts family (also C, Go, Rust, PHP, Java… keyword-compatible)
 *   - python family
 *   - markup (HTML/XML/SVG)
 *   - css/scss
 *   - json
 *   - plain fallback
 *
 * Very large payloads skip tokenization (perf guard) and render as-is.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'com' | 'tag' | 'attr' | 'key' | 'punc' | 'plain';

interface Token {
  kind: TokenKind;
  text: string;
}

/** Max chars tokenized — beyond this, render plain (perf guard). */
const MAX_TOKENIZE_CHARS = 30_000;

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class',
  'import', 'export', 'from', 'async', 'await', 'new', 'this', 'typeof', 'instanceof',
  'null', 'undefined', 'true', 'false', 'try', 'catch', 'finally', 'throw', 'switch',
  'case', 'break', 'continue', 'extends', 'super', 'static', 'get', 'set', 'of', 'in',
  'do', 'yield', 'default', 'delete', 'void', 'interface', 'type', 'enum', 'implements',
  'public', 'private', 'protected', 'readonly', 'as', 'satisfies', 'namespace', 'declare',
]);

const PY_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from',
  'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue',
  'lambda', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'global',
  'nonlocal', 'yield', 'async', 'await', 'assert', 'del', 'match', 'case',
]);

export function langFamilyFromLang(lang?: string): 'js' | 'py' | 'markup' | 'css' | 'json' | 'plain' {
  if (!lang) return 'plain';
  const l = lang.toLowerCase().trim();
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'mjs', 'cjs', 'java', 'c', 'cpp', 'c++', 'csharp', 'cs', 'go', 'rust', 'rs', 'php', 'swift', 'kotlin', 'scala', 'dart'].includes(l)) return 'js';
  if (['py', 'python', 'rb', 'ruby'].includes(l)) return 'py';
  if (['html', 'htm', 'xml', 'svg', 'vue', 'svelte'].includes(l)) return 'markup';
  if (['css', 'scss', 'less'].includes(l)) return 'css';
  if (['json', 'jsonc', 'json5'].includes(l)) return 'json';
  return 'plain';
}

export function langFamilyFromPath(path: string): 'js' | 'py' | 'markup' | 'css' | 'json' | 'plain' {
  const m = path.match(/\.([A-Za-z0-9]+)$/);
  return langFamilyFromLang(m?.[1]);
}

// ── Code-family tokenizer (js/ts/py + keyword-compatible languages) ─────────

const CODE_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=+\-*/<>!?&|%~^@]+)/g;

function tokenizeCode(src: string, keywords: Set<string>): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_RE.exec(src)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', text: src.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'com', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'str', text: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: 'num', text: m[3] });
    else if (m[4] !== undefined) {
      // `#` comments only make sense for python-family — a `#` inside JS is
      // rare enough to leave as comment coloring anyway (harmless).
      tokens.push({ kind: keywords.has(m[4]) ? 'kw' : 'plain', text: m[4] });
    } else if (m[5] !== undefined) tokens.push({ kind: 'punc', text: m[5] });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ kind: 'plain', text: src.slice(last) });
  return tokens;
}

// ── Markup tokenizer (HTML/XML) — small state machine ───────────────────────

function tokenizeMarkup(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, text: string) => {
    if (text) tokens.push({ kind, text });
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      push('plain', src.slice(i));
      break;
    }
    push('plain', src.slice(i, lt));

    // Comment / doctype
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      push('com', src.slice(lt, stop));
      i = stop;
      continue;
    }
    const bang = src.slice(lt, lt + 9).toUpperCase();
    if (bang.startsWith('<!DOCTYPE')) {
      const end = src.indexOf('>', lt);
      const stop = end === -1 ? src.length : end + 1;
      push('com', src.slice(lt, stop));
      i = stop;
      continue;
    }

    // Closing tag
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const stop = end === -1 ? src.length : end + 1;
      push('punc', '</');
      const nameM = src.slice(lt + 2, stop).match(/^[\w:-]+/);
      if (nameM) push('tag', nameM[0]);
      push('punc', src.slice(lt + 2 + (nameM?.[0].length ?? 0), stop));
      i = stop;
      continue;
    }

    // Opening tag: <name attr="value" …>
    const openM = src.slice(lt).match(/^<([A-Za-z][\w:-]*)/);
    if (!openM) {
      push('plain', '<');
      i = lt + 1;
      continue;
    }
    push('punc', '<');
    push('tag', openM[1]);
    i = lt + 1 + openM[0].length;

    // Attributes until '>' (strings may contain '>')
    while (i < src.length) {
      const ch = src[i];
      if (ch === '>') {
        push('punc', '>');
        i++;
        break;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < src.length && src[j] !== quote) j++;
        const stop = Math.min(j + 1, src.length);
        push('str', src.slice(i, stop));
        i = stop;
        continue;
      }
      const wsM = src.slice(i).match(/^\s+/);
      if (wsM) {
        push('plain', wsM[0]);
        i += wsM[0].length;
        continue;
      }
      const attrM = src.slice(i).match(/^[\w-]+(?=\s*=)/);
      if (attrM) {
        push('attr', attrM[0]);
        i += attrM[0].length;
        continue;
      }
      const otherM = src.slice(i).match(/^[^>"'\s]+/);
      if (otherM) {
        push('plain', otherM[0]);
        i += otherM[0].length;
        continue;
      }
      push('plain', ch);
      i++;
    }
  }
  return tokens;
}

// ── CSS tokenizer ────────────────────────────────────────────────────────────

function tokenizeCss(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|([{}();:,])|(@[\w-]+)|([-A-Za-z]+(?=\s*:))|(\.[-\w]+|#[-\w]+|&|::?[-\w]+)|(-?\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', text: src.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'com', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'str', text: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: 'punc', text: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: 'kw', text: m[4] });
    else if (m[5] !== undefined) tokens.push({ kind: 'attr', text: m[5] });
    else if (m[6] !== undefined) tokens.push({ kind: 'tag', text: m[6] });
    else if (m[7] !== undefined) tokens.push({ kind: 'num', text: m[7] });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ kind: 'plain', text: src.slice(last) });
  return tokens;
}

// ── JSON tokenizer ───────────────────────────────────────────────────────────

function tokenizeJson(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d[\d.]*(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) tokens.push({ kind: 'plain', text: src.slice(last, m.index) });
    if (m[1] !== undefined) {
      tokens.push({ kind: m[2] !== undefined ? 'key' : 'str', text: m[1] });
      if (m[2] !== undefined) tokens.push({ kind: 'punc', text: m[2] });
    } else if (m[3] !== undefined) tokens.push({ kind: 'kw', text: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: 'num', text: m[4] });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ kind: 'plain', text: src.slice(last) });
  return tokens;
}

// ── Renderer ────────────────────────────────────────────────────────────────

function tokenize(src: string, family: ReturnType<typeof langFamilyFromLang>): Token[] {
  switch (family) {
    case 'js':
      return tokenizeCode(src, JS_KEYWORDS);
    case 'py':
      return tokenizeCode(src, PY_KEYWORDS);
    case 'markup':
      return tokenizeMarkup(src);
    case 'css':
      return tokenizeCss(src);
    case 'json':
      return tokenizeJson(src);
    default:
      return [{ kind: 'plain', text: src }];
  }
}

/**
 * Syntax-highlighted code as React nodes. `truncate` caps very large inputs
 * (the tail renders as plain text). Never splits on backticks/HTML — the
 * output is a span tree, so content cannot break out of the <pre>.
 */
export const HighlightedCode: React.FC<{ code: string; lang?: string }> = React.memo(({ code, lang }) => {
  const family = langFamilyFromLang(lang);
  let head = code;
  let tail = '';
  if (code.length > MAX_TOKENIZE_CHARS) {
    head = code.slice(0, MAX_TOKENIZE_CHARS);
    tail = code.slice(MAX_TOKENIZE_CHARS);
  }
  const tokens = React.useMemo(() => tokenize(head, family), [head, family]);
  return (
    <>
      {tokens.map((tk, i) =>
        tk.kind === 'plain' ? (
          <React.Fragment key={i}>{tk.text}</React.Fragment>
        ) : (
          <span key={i} className={`tok-${tk.kind}`}>{tk.text}</span>
        )
      )}
      {tail && <span>{tail}</span>}
    </>
  );
});
