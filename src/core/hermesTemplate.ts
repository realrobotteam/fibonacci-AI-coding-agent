/**
 * Hermes chat-template support.
 *
 * This module is a TypeScript port of the Jinja chat_template the user provided,
 * plus a parser for the Hermes tool-call format (`<|tool_call>call:name{args}<tool_call|>`).
 *
 * The Jinja template runs server-side at the API endpoint; we don't execute
 * Jinja here. Instead:
 *
 *   1. `renderHermesPrompt` — produces the EXACT byte sequence the Jinja
 *      template would produce, given the same inputs. This is used for:
 *        - debug logging (the user can see what the model actually receives)
 *        - fallback "raw prompt" mode when the API endpoint doesn't apply the
 *          chat template itself
 *
 *   2. `parseHermesToolCalls` — extracts `<|tool_call>call:name{args}<tool_call|>`
 *      blocks from the assistant's text response. This is the primary mechanism
 *      for Hermes-mode tool calling.
 *
 *   3. `parseHermesThinking` — extracts the `<|channel>thought\n...\n<channel|>`
 *      reasoning channel so the UI can show it as a collapsible "thinking" block.
 *
 *   4. `formatHermesToolResponse` — produces the `<|tool_response>response:name{...}<tool_response|>`
 *      wrapper that the template's `format_tool_response_block` macro emits.
 *
 *   5. `formatHermesToolDeclaration` — produces the
 *      `declaration:name{description:"...",parameters:{...}}` block that the
 *      template's `format_function_declaration` macro emits.
 *
 * Token vocabulary used:
 *
 *   <|turn>system\n ... <turn|>
 *   <|turn>user\n ... <turn|>
 *   <|turn>model\n ... <turn|>
 *   <|think|>
 *   <|channel>thought\n ... <channel|>
 *   <|tool> declaration:name{...} <tool|>
 *   <|tool_call>call:name{args}<tool_call|>
 *   <|tool_response>response:name{...}<tool_response|>
 *   <|image|> / <|audio|> / <|video|>
 *
 * NOTE: Tool call arguments use standard JSON format with double quotes.
 * The parser accepts both standard JSON and the legacy `<|"|>` quote token format
 * for backwards compatibility.
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions';

// ─────────────────────────────────────────────────────────────────────────────
// Token vocabulary
// ─────────────────────────────────────────────────────────────────────────────

const Q = '"'; // Use standard JSON double quote (not the non-standard <|"|> token)
const TURN = '<|turn>';
const END_TURN = '<turn|>';
const THINK = '<|think|>';
const CH_THOUGHT_OPEN = '<|channel>thought\n';
const CH_CLOSE = '\n<channel|>';
const TOOL_OPEN = '<|tool>';
const TOOL_CLOSE = '<tool|>';
const TOOL_CALL_OPEN = '<|tool_call>call:';
const TOOL_CALL_CLOSE = '<tool_call|>';
const TOOL_RESP_OPEN = '<|tool_response>';
const TOOL_RESP_CLOSE = '<tool_response|>';
const BOS = '<|begin_of_text|>'; // approximates bos_token

// ─────────────────────────────────────────────────────────────────────────────
// Argument formatting — mirrors the `format_argument` Jinja macro.
// ─────────────────────────────────────────────────────────────────────────────

export function formatArgument(argument: unknown, escapeKeys = true): string {
  if (typeof argument === 'string') {
    // Escape backslashes and double quotes for standard JSON
    const escaped = argument.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return Q + escaped + Q;
  }
  if (typeof argument === 'boolean') {
    return argument ? 'true' : 'false';
  }
  if (argument === null || argument === undefined) {
    return 'null';
  }
  if (typeof argument === 'number') {
    if (!isFinite(argument)) return 'null';
    return String(argument);
  }
  if (Array.isArray(argument)) {
    return (
      '[' +
      argument.map((item) => formatArgument(item, escapeKeys)).join(',') +
      ']'
    );
  }
  if (typeof argument === 'object') {
    const entries = Object.entries(argument as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0]));
    return (
      '{' +
      entries
        .map(
          ([k, v]) =>
            (escapeKeys ? Q + k + Q : k) + ':' + formatArgument(v, escapeKeys)
        )
        .join(',') +
      '}'
    );
  }
  return String(argument);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool declaration formatting — mirrors `format_function_declaration`.
// ─────────────────────────────────────────────────────────────────────────────

interface JsonSchemaProperty {
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchemaProperty & { required?: string[] };
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  nullable?: boolean;
  [k: string]: unknown;
}

function formatParameters(
  properties: Record<string, JsonSchemaProperty> | undefined,
  _required: string[] | undefined,
  filterKeys = false
): string {
  if (!properties) return '';
  const standardKeys = new Set([
    'description',
    'type',
    'properties',
    'required',
    'nullable',
  ]);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(properties).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (filterKeys && standardKeys.has(key)) continue;
    let addComma = false;
    const segs: string[] = [];
    if (value.description) {
      segs.push(`description:${Q}${value.description}${Q}`);
      addComma = true;
    }
    const typeU = (typeof value.type === 'string' ? value.type : '').toUpperCase();
    if (typeU === 'STRING') {
      if (value.enum) {
        if (addComma) segs.push(',');
        segs.push(`enum:${formatArgument(value.enum)}`);
        addComma = true;
      }
    } else if (typeU === 'ARRAY') {
      if (value.items && typeof value.items === 'object') {
        if (addComma) segs.push(',');
        segs.push('items:{');
        const itemsInner: string[] = [];
        for (const [ik, iv] of Object.entries(value.items).sort((a, b) =>
          a[0].localeCompare(b[0])
        )) {
          if (iv === null || iv === undefined) continue;
          if (ik === 'properties') {
            itemsInner.push('properties:{');
            if (iv && typeof iv === 'object') {
              itemsInner.push(
                formatParameters(
                  (iv as { properties?: Record<string, JsonSchemaProperty> }).properties ??
                    (iv as Record<string, JsonSchemaProperty>),
                  value.items.required ?? []
                )
              );
            }
            itemsInner.push('}');
          } else if (ik === 'required') {
            itemsInner.push('required:[');
            const arr = (iv as string[]) ?? [];
            itemsInner.push(arr.map((r) => Q + r + Q).join(','));
            itemsInner.push(']');
          } else if (ik === 'type') {
            if (typeof iv === 'string') {
              itemsInner.push(`type:${formatArgument(iv.toUpperCase())}`);
            } else if (Array.isArray(iv)) {
              itemsInner.push(
                `type:${formatArgument(iv.map((x) => String(x).toUpperCase()))}`
              );
            }
          } else {
            itemsInner.push(`${ik}:${formatArgument(iv)}`);
          }
        }
        segs.push(itemsInner.join(','));
        segs.push('}');
        addComma = true;
      }
    }
    if (value.nullable) {
      if (addComma) segs.push(',');
      segs.push('nullable:true');
      addComma = true;
    }
    if (typeU === 'OBJECT') {
      if (value.properties && typeof value.properties === 'object') {
        if (addComma) segs.push(',');
        segs.push('properties:{');
        segs.push(formatParameters(value.properties, value.required ?? []));
        segs.push('}');
        addComma = true;
      } else {
        // bare object — recurse with filter_keys=true
        if (addComma) segs.push(',');
        segs.push('properties:{');
        segs.push(formatParameters(value as Record<string, JsonSchemaProperty>, value.required ?? [], true));
        segs.push('}');
        addComma = true;
      }
      if (value.required && Array.isArray(value.required) && value.required.length > 0) {
        if (addComma) segs.push(',');
        segs.push('required:[');
        segs.push(value.required.map((r) => Q + r + Q).join(','));
        segs.push(']');
        addComma = true;
      }
    }
    if (!addComma) {
      // ensure type comes through even if no description
      addComma = true;
    }
    segs.push(`,type:${Q}${typeU || 'STRING'}${Q}`);
    parts.push(`${key}:{${segs.join('')}}`);
  }
  return parts.join(',');
}

export function formatToolDeclaration(tool: ChatCompletionTool): string {
  const fn = ((tool as unknown) as { function?: Record<string, unknown> }).function ??
    ((tool as unknown) as Record<string, unknown>);
  const name = String(fn.name ?? '');
  const description = String(fn.description ?? '');
  const params = fn.parameters as JsonSchemaProperty | undefined;
  let out = `declaration:${name}{description:${Q}${description}${Q}`;
  if (params) {
    out += ',parameters:{';
    if (params.properties) {
      out += `properties:{ ${formatParameters(params.properties, params.required)} },`;
    }
    if (params.required && Array.isArray(params.required) && params.required.length > 0) {
      out += 'required:[';
      out += (params.required as string[]).map((r) => Q + r + Q).join(',');
      out += '],';
    }
    if (params.type) {
      out += `type:${Q}${String(params.type).toUpperCase()}${Q}}`;
    }
    out += '}';
  }
  out += '}';
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool response formatting — mirrors `format_tool_response_block`.
// ─────────────────────────────────────────────────────────────────────────────

export function formatToolResponseBlock(toolName: string, response: unknown): string {
  let body: string;
  if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
    const entries = Object.entries(response as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0]));
    body =
      'response:' +
      toolName +
      '{' +
      entries.map(([k, v]) => k + ':' + formatArgument(v, false)).join(',') +
      '}';
  } else {
    body = 'response:' + toolName + '{value:' + formatArgument(response, false) + '}';
  }
  return TOOL_RESP_OPEN + body + TOOL_RESP_CLOSE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes tool-call PARSING — extract `<|tool_call>call:name{args}<tool_call|>`
// from the assistant's text response.
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedHermesToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

/**
 * Parse a single Hermes tool-call argument string (the inside of `{...}`) into
 * a JS object. Handles nested braces, quoted strings (using both `"` and the
 * Hermes `<|"|>` token), and bare keys (no quotes).
 */
/**
 * Convert an escape sequence (the character after `\`) to its actual character.
 * Handles: \n \t \r \\ \" \' \/ \b \f \uXXXX
 */
function unescapeChar(s: string, j: number): { char: string; consumed: number } {
  const next = s[j + 1];
  if (next === undefined) return { char: '\\', consumed: 1 };
  switch (next) {
    case 'n': return { char: '\n', consumed: 2 };
    case 't': return { char: '\t', consumed: 2 };
    case 'r': return { char: '\r', consumed: 2 };
    case '\\': return { char: '\\', consumed: 2 };
    case '"': return { char: '"', consumed: 2 };
    case "'": return { char: "'", consumed: 2 };
    case '/': return { char: '/', consumed: 2 };
    case 'b': return { char: '\b', consumed: 2 };
    case 'f': return { char: '\f', consumed: 2 };
    case 'u': {
      // \uXXXX — 4 hex digits
      const hex = s.slice(j + 2, j + 6);
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        return { char: String.fromCharCode(parseInt(hex, 16)), consumed: 6 };
      }
      return { char: next, consumed: 2 };
    }
    default:
      // Unknown escape — just output the character literally
      return { char: next, consumed: 2 };
  }
}

function parseHermesArgsObject(s: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;
  const len = s.length;
  while (i < len) {
    // skip whitespace and commas
    while (i < len && (s[i] === ' ' || s[i] === ',' || s[i] === '\n' || s[i] === '\t')) i++;
    if (i >= len) break;
    // read key (either quoted or bare)
    let key = '';
    if (s[i] === '"') {
      i++;
      while (i < len && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < len) {
          const { char, consumed } = unescapeChar(s, i);
          key += char;
          i += consumed;
        } else {
          key += s[i++];
        }
      }
      i++; // skip closing "
    } else if (s[i] === '<' && s.substr(i, 5) === '<|"|>') {
      // Legacy key with <|"|> quote token
      i += 5;
      while (i < len && s.substr(i, 5) !== '<|"|>') {
        if (s[i] === '\\' && i + 1 < len) {
          const { char, consumed } = unescapeChar(s, i);
          key += char;
          i += consumed;
        } else {
          key += s[i++];
        }
      }
      i += 5; // skip closing <|"|>
    } else {
      while (i < len && s[i] !== ':') key += s[i++];
    }
    key = key.trim();
    if (!key) break;
    // skip whitespace
    while (i < len && (s[i] === ' ' || s[i] === '\t')) i++;
    if (s[i] !== ':') break;
    i++; // skip ':'
    while (i < len && (s[i] === ' ' || s[i] === '\t')) i++;
    // read value
    const { value, next } = parseHermesValue(s, i);
    result[key] = value;
    i = next;
  }
  return result;
}

function parseHermesValue(
  s: string,
  i: number
): { value: unknown; next: number } {
  if (i >= s.length) return { value: null, next: i };
  const ch = s[i];
  // String with double quotes (standard JSON)
  if (ch === '"') {
    let j = i + 1;
    let out = '';
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\' && j + 1 < s.length) {
        const { char, consumed } = unescapeChar(s, j);
        out += char;
        j += consumed;
      } else {
        out += s[j++];
      }
    }
    j++; // skip closing
    return { value: out, next: j };
  }
  // Legacy string with <|"|> quote token (for backwards compatibility)
  const LEGACY_QUOTE = '<|"|>';
  if (ch === '<' && s.substr(i, LEGACY_QUOTE.length) === LEGACY_QUOTE) {
    let j = i + LEGACY_QUOTE.length;
    let out = '';
    while (j < s.length && s.substr(j, LEGACY_QUOTE.length) !== LEGACY_QUOTE) {
      if (s[j] === '\\' && j + 1 < s.length) {
        const { char, consumed } = unescapeChar(s, j);
        out += char;
        j += consumed;
      } else {
        out += s[j++];
      }
    }
    j += LEGACY_QUOTE.length; // skip closing
    return { value: out, next: j };
  }
  // Object
  if (ch === '{') {
    let depth = 1;
    let j = i + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    const inner = s.slice(i + 1, j);
    return { value: parseHermesArgsObject(inner), next: j + 1 };
  }
  // Array
  if (ch === '[') {
    let depth = 1;
    let j = i + 1;
    const items: unknown[] = [];
    let itemStart = j;
    while (j < s.length && depth > 0) {
      const c = s[j];
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          const seg = s.slice(itemStart, j).trim();
          if (seg) {
            const { value } = parseHermesValue(seg, 0);
            items.push(value);
          }
          break;
        }
      } else if (c === ',' && depth === 1) {
        const seg = s.slice(itemStart, j).trim();
        if (seg) {
          const { value } = parseHermesValue(seg, 0);
          items.push(value);
        }
        itemStart = j + 1;
      } else if (c === '"' || c === '{' || c === '[') {
        // skip nested structure
        let d = 1;
        const quote = c === '"' ? '"' : null;
        j++;
        while (j < s.length && d > 0) {
          if (quote) {
            if (s[j] === '\\') { j += 2; continue; }
            if (s[j] === quote) d--;
          } else {
            if (s[j] === c) d++;
            else if (s[j] === (c === '{' ? '}' : ']')) d--;
          }
          j++;
        }
        continue;
      }
      j++;
    }
    return { value: items, next: j + 1 };
  }
  // Number
  if (ch === '-' || (ch >= '0' && ch <= '9')) {
    let j = i;
    while (j < s.length && /[0-9.eE+-]/.test(s[j])) j++;
    const numStr = s.slice(i, j);
    const n = Number(numStr);
    if (!isNaN(n)) return { value: n, next: j };
  }
  // Boolean / null
  if (s.substr(i, 4) === 'true') return { value: true, next: i + 4 };
  if (s.substr(i, 5) === 'false') return { value: false, next: i + 5 };
  if (s.substr(i, 4) === 'null') return { value: null, next: i + 4 };
  // Bare token (until comma or end)
  let j = i;
  while (j < s.length && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++;
  return { value: s.slice(i, j).trim(), next: j };
}

/**
 * Parse all Hermes tool-call blocks from the assistant's text.
 * Returns the parsed calls plus the prose with the blocks stripped.
 */
export function parseHermesToolCalls(text: string): {
  calls: ParsedHermesToolCall[];
  prose: string;
} {
  const calls: ParsedHermesToolCall[] = [];
  let prose = '';
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf(TOOL_CALL_OPEN, i);
    if (openIdx === -1) {
      prose += text.slice(i);
      break;
    }
    prose += text.slice(i, openIdx);
    const afterCallColon = openIdx + TOOL_CALL_OPEN.length; // points to start of tool name
    // The tool name goes from afterCallColon up to the next '{'.
    const braceIdx = text.indexOf('{', afterCallColon);
    if (braceIdx === -1) {
      // Malformed (no opening brace) — emit the open token as prose and skip
      prose += TOOL_CALL_OPEN;
      i = afterCallColon;
      continue;
    }
    const name = text.slice(afterCallColon, braceIdx).trim();
    if (!name) {
      // No name — skip
      prose += TOOL_CALL_OPEN;
      i = afterCallColon;
      continue;
    }
    // Find the matching `}` that closes the args object, honoring nested
    // braces and quoted strings (both `"` and the Hermes `<|"|>` token).
    let depth = 0;
    let j = braceIdx;
    let inStr: string | null = null;
    while (j < text.length) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (inStr === Q) {
          if (text.substr(j, Q.length) === Q) {
            j += Q.length;
            inStr = null;
            continue;
          }
        } else if (c === inStr) {
          inStr = null;
        }
      } else {
        if (c === '"') {
          inStr = '"';
        } else if (c === Q[0] && text.substr(j, Q.length) === Q) {
          inStr = Q;
          j += Q.length;
          continue;
        } else if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0) { j++; break; }
        }
      }
      j++;
    }
    if (depth !== 0) {
      // Unbalanced — incomplete (likely streaming). Strip and stop.
      break;
    }
    // `j` is now just after the closing `}`
    const argsEnd = j;
    const closeIdx = text.indexOf(TOOL_CALL_CLOSE, argsEnd);
    if (closeIdx === -1) {
      // streaming — incomplete; strip everything from open to end
      break;
    }
    const argsStr = text.slice(braceIdx + 1, argsEnd - 1);
    const args = parseHermesArgsObject(argsStr);
    const raw = text.slice(openIdx, closeIdx + TOOL_CALL_CLOSE.length);
    calls.push({ name, args, raw });
    i = closeIdx + TOOL_CALL_CLOSE.length;
  }
  prose = prose.replace(/\n{3,}/g, '\n\n').trim();
  return { calls, prose };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermes thinking/reasoning extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract reasoning/thinking channels from the assistant's text.
 *
 * Handles THREE variants the model might emit:
 *   1. Canonical:  `<|channel>thought\n...\n<channel|>`
 *   2. Bare:       `<|channel>\n...\n<channel|>`  (model forgot `thought` keyword)
 *   3. Unclosed:   `<|channel>\n...` (streaming or model forgot to close)
 *
 * Also strips orphan `<|channel>` and `<channel|>` tokens from prose so the
 * user never sees raw special tokens in the chat.
 *
 * Returns the cleaned prose (without the thought block) and the thought
 * content separately.
 */
export function parseHermesThinking(text: string): {
  prose: string;
  thinking: string;
} {
  let thinking = '';
  let prose = '';
  let i = 0;

  // CRITICAL FIX (bug M — thinking and text parsing problems):
  //
  // The Gemma4 template emits thinking in these forms:
  //   1. `<|think|>\n...` — the think token (when enable_thinking is true)
  //   2. `<|channel>thought\n...\n<channel|>` — the canonical thinking channel
  //   3. `<|channel>\n...\n<channel|>` — bare channel (model forgot "thought")
  //   4. `<|channel>thought\n<channel|>` — EMPTY thinking (when enable_thinking
  //      is false, the template emits this at generation start)
  //
  // The previous parser handled forms 2 and 3 but NOT form 1 (<|think|>).
  // It also treated empty thinking channels (form 4) as if they had content,
  // which could cause the parser to lose track of where the thinking ends.
  //
  // Now we:
  //   - Strip `<|think|>` tokens (they're just markers, no content)
  //   - Handle empty `<|channel>thought\n<channel|>` correctly (no thinking)
  //   - Handle `<|begin_of_text|>` token at the start

  // Strip BOS token if present at the start.
  let workText = text;
  if (workText.startsWith(BOS)) {
    workText = workText.slice(BOS.length);
  }

  // Strip <|think|> tokens — they're just markers, no content.
  workText = workText.replace(/<\|think\|>/g, '');

  // Pattern: match `<|channel>` optionally followed by `thought` and
  // whitespace, then content, then close.
  const channelOpenRegex = /<\|channel>(?:thought)?\s*/g;

  while (i < workText.length) {
    channelOpenRegex.lastIndex = i;
    const m = channelOpenRegex.exec(workText);
    if (!m) {
      prose += workText.slice(i);
      break;
    }
    const openIdx = m.index;
    prose += workText.slice(i, openIdx);
    const afterOpen = m.index + m[0].length;

    // Look for the close: `\n<channel|>` (canonical) or bare `<channel|>`.
    let closeIdx = workText.indexOf(CH_CLOSE, afterOpen);
    let closeLen = CH_CLOSE.length;
    if (closeIdx === -1) {
      closeIdx = workText.indexOf('<channel|>', afterOpen);
      closeLen = '<channel|>'.length;
    }
    if (closeIdx === -1) {
      // Unclosed — the rest is partial thinking (streaming or model forgot).
      thinking += workText.slice(afterOpen);
      break;
    }
    // Extract the thinking content (between afterOpen and closeIdx).
    let thinkContent = workText.slice(afterOpen, closeIdx);
    // Strip a single trailing newline.
    if (thinkContent.endsWith('\n')) thinkContent = thinkContent.slice(0, -1);
    // Only add non-empty thinking. Empty thinking channels (form 4) are
    // just markers and should not produce thinking content.
    if (thinkContent.trim().length > 0) {
      thinking += thinkContent;
      if (thinking && !thinking.endsWith('\n')) thinking += '\n';
    }
    i = closeIdx + closeLen;
  }

  // Strip any orphan `<|channel>` or `<channel|>` tokens that the model
  // emitted without proper structure. Also strip `<|think|>` just in case.
  prose = prose
    .replace(/<\|think\|>/g, '')
    .replace(/<\|channel>(?:thought)?\s*/g, '')
    .replace(/<channel\|>/g, '')
    .replace(/<\|begin_of_text\|>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    prose,
    thinking: thinking.trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full prompt rendering — the TS port of the Jinja template's main body.
// Used for debug logging and raw-prompt fallback.
// ─────────────────────────────────────────────────────────────────────────────

export interface HermesMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning?: string | null;
  toolCalls?: Array<{
    id: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
  toolResponses?: Array<{ name: string; response: unknown }>;
  /** For role: 'tool' messages that follow an assistant tool_call — the name
   *  of the tool that produced this result, plus the tool_call_id linkage. */
  name?: string;
  toolCallId?: string;
}

export interface RenderOptions {
  enableThinking?: boolean;
  addGenerationPrompt?: boolean;
  bosToken?: string;
}

export function renderHermesPrompt(
  messages: HermesMessage[],
  tools: ChatCompletionTool[] | undefined,
  options: RenderOptions = {}
): string {
  const enableThinking = options.enableThinking === true;
  const addGen = options.addGenerationPrompt !== false;
  const bos = options.bosToken ?? BOS;
  const out: string[] = [bos];

  let loopMessages = messages;
  const hasSystem = messages[0]?.role === 'system' || messages[0]?.role === 'developer';
  const needsSystemBlock =
    enableThinking || (tools && tools.length > 0) || hasSystem;

  if (needsSystemBlock) {
    out.push(TURN + 'system\n');
    if (enableThinking) {
      out.push(THINK + '\n');
    }
    if (hasSystem) {
      const sysContent = messages[0].content;
      if (typeof sysContent === 'string') {
        out.push(sysContent.trim());
      }
      loopMessages = messages.slice(1);
    }
    if (tools && tools.length > 0) {
      for (const tool of tools) {
        out.push(TOOL_OPEN);
        out.push(formatToolDeclaration(tool).trim());
        out.push(TOOL_CLOSE);
      }
    }
    out.push(END_TURN + '\n');
  }

  // Pre-scan: last user message index
  let lastUserIdx = -1;
  for (let i = 0; i < loopMessages.length; i++) {
    if (loopMessages[i].role === 'user') lastUserIdx = i;
  }

  for (let idx = 0; idx < loopMessages.length; idx++) {
    const message = loopMessages[idx];
    if (message.role === 'tool') continue;
    const role = message.role === 'assistant' ? 'model' : message.role;

    // Detect continuation (skip duplicate turn header for consecutive assistant turns)
    let prevRole: string | null = null;
    for (let j = idx - 1; j >= 0; j--) {
      if (loopMessages[j].role !== 'tool') {
        prevRole = loopMessages[j].role === 'assistant' ? 'model' : loopMessages[j].role;
        break;
      }
    }
    const continueSameModelTurn = role === 'model' && prevRole === 'model';
    if (!continueSameModelTurn) {
      out.push(TURN + role + '\n');
    }

    // Render reasoning channel (only after the last user message, if tool calls follow)
    const thinkingText = message.reasoning;
    if (thinkingText && idx > lastUserIdx && message.toolCalls && message.toolCalls.length > 0) {
      out.push(CH_THOUGHT_OPEN + thinkingText + CH_CLOSE);
    }

    // Tool calls
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const tc of message.toolCalls) {
        const fnName = tc.function.name;
        const fnArgs = tc.function.arguments;
        let argsStr: string;
        if (typeof fnArgs === 'string') {
          argsStr = fnArgs;
        } else if (fnArgs && typeof fnArgs === 'object') {
          const entries = Object.entries(fnArgs)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => k + ':' + formatArgument(v, false));
          argsStr = '{' + entries.join(',') + '}';
        } else {
          argsStr = '{}';
        }
        out.push(TOOL_CALL_OPEN + fnName + argsStr + TOOL_CALL_CLOSE);
      }
    }

    // Forward-scan for tool result messages (OpenAI Chat Completions style)
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (let k = idx + 1; k < loopMessages.length; k++) {
        if (loopMessages[k].role !== 'tool') break;
        const follow = loopMessages[k];
        let toolName = follow.name ?? 'unknown';
        // Resolve tool name from the tool_call_id
        for (const tc of message.toolCalls) {
          if (tc.id === follow.toolCallId) {
            toolName = tc.function.name;
            break;
          }
        }
        const toolBody = follow.content ?? '';
        out.push(formatToolResponseBlock(toolName, toolBody));
      }
    }

    // Content
    if (typeof message.content === 'string' && message.content) {
      // Strip thinking blocks from assistant content (mirrors `strip_thinking`)
      const { prose } = parseHermesThinking(message.content);
      out.push(role === 'model' ? prose : message.content.trim());
    }

    out.push(END_TURN + '\n');
  }

  if (addGen) {
    out.push(TURN + 'model\n');
    if (!enableThinking) {
      out.push(CH_THOUGHT_OPEN + CH_CLOSE);
    }
  }

  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: convert a generic args object into a Hermes tool-call emit string.
// Useful when the LLM needs a "here's how you emit a tool call" example.
// ─────────────────────────────────────────────────────────────────────────────

export function emitToolCallExample(name: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => k + ':' + formatArgument(v, false));
  return TOOL_CALL_OPEN + name + '{' + entries.join(',') + '}' + TOOL_CALL_CLOSE;
}
