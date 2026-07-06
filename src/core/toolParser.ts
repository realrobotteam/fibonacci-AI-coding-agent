/**
 * XML-based tool-call parser.
 *
 * The Fibonacci API doesn't reliably populate the structured `tool_calls` field
 * in the OpenAI response — instead, the model emits tool calls as XML-style
 * tags inside the `content` string. This parser extracts them.
 *
 * Supported format (Cline-style):
 *
 *   <write_to_file>
 *   <path>src/index.html</path>
 *   <content>
 *   <!DOCTYPE html>
 *   ...
 *   </content>
 *   </write_to_file>
 *
 * Multiple tool calls can be chained in a single response. Each must be a
 * complete open/close tag pair. Nested tags inside a parameter value (e.g.
 * HTML inside <content>) are handled by matching the closing tag of the
 * same name as the tool.
 */

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The full XML block as it appeared in the text (for stripping). */
  raw: string;
}

/** Top-level tool tag names we recognize. */
const KNOWN_TOOLS = new Set<string>([
  'read_file',
  'write_to_file',
  'replace_in_file',
  'list_files',
  'search_files',
  'get_active_editor',
  'execute_command',
  'run_in_terminal',
  'get_command_output',
  'list_mcp_tools',
  'call_mcp_tool',
  'get_mcp_resources',
  'manage_mcp_servers',
  'update_todos',
  'request_mode_switch',
]);

/**
 * Parse all tool-call XML blocks from the assistant's text response.
 * Returns the list of parsed calls plus the text with the blocks stripped
 * (so the caller can show the user a clean prose explanation).
 *
 * When `streaming` is true, incomplete tool blocks (open tag without close)
 * at the end of the text are stripped from prose — they're still being streamed.
 */
export function parseToolCalls(text: string, options?: { streaming?: boolean }): {
  calls: ParsedToolCall[];
  prose: string;
} {
  const calls: ParsedToolCall[] = [];
  let prose = '';
  const streaming = options?.streaming === true;

  // Walk the text, looking for `<tool_name>` where tool_name is known.
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf('<', i);
    if (openIdx === -1) {
      prose += text.slice(i);
      break;
    }

    // Append any text before the `<` to prose.
    prose += text.slice(i, openIdx);

    // Try to match `<tool_name>` at this position.
    const tagMatch = matchOpenTag(text, openIdx);
    if (!tagMatch) {
      // Not a tool tag — just a literal `<`. Skip it.
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    const { name, afterOpen } = tagMatch;
    if (!KNOWN_TOOLS.has(name)) {
      // Unknown tag — treat as literal.
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    // Find the matching close tag `</tool_name>`.
    const closeTag = `</${name}>`;
    const nextOpenIdx = findNextOpenTag(text, afterOpen, KNOWN_TOOLS);
    const closeIdx = text.indexOf(closeTag, afterOpen);
    if (closeIdx === -1) {
      // No closing tag found.
      if (streaming) {
        // In streaming mode, this is an incomplete tool block still being
        // streamed. Strip everything from the open tag to the end — don't
        // show it as prose.
        break;
      }
      // Non-streaming: treat the `<tool_name>` as literal.
      prose += '<';
      i = openIdx + 1;
      continue;
    }
    // If there's another tool opening before our close tag, the model is
    // chaining tool calls — but that means our close tag belongs to the
    // inner tool. Restrict closeIdx to before the next opening.
    if (nextOpenIdx !== -1 && nextOpenIdx < closeIdx) {
      // The inner tool will be picked up in the next iteration. For now,
      // treat the current `<name>` as a literal (the next iteration starts
      // from nextOpenIdx).
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    const inner = text.slice(afterOpen, closeIdx);
    const raw = text.slice(openIdx, closeIdx + closeTag.length);

    // Parse inner parameters: each is `<param>value</param>`
    const args = parseParams(inner);

    calls.push({ name, args, raw });
    i = closeIdx + closeTag.length;
  }

  // Clean up prose: collapse excessive whitespace, trim.
  prose = prose
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return { calls, prose };
}

/** Match `<tool_name>` at position i. Returns the name and index after `>`. */
function matchOpenTag(
  text: string,
  i: number
): { name: string; afterOpen: number } | null {
  // Must start with `<` followed by a letter.
  if (text[i] !== '<' || !/[a-z_]/.test(text[i + 1] ?? '')) return null;
  let j = i + 1;
  while (j < text.length && /[a-z0-9_]/.test(text[j])) j++;
  const name = text.slice(i + 1, j);
  if (!name) return null;
  // Skip whitespace then expect `>`.
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] !== '>') return null;
  return { name, afterOpen: j + 1 };
}

/** Find the index of the next `<tool_name>` opening tag after `from`. */
function findNextOpenTag(
  text: string,
  from: number,
  knownTools: Set<string>
): number {
  let i = from;
  while (i < text.length) {
    const openIdx = text.indexOf('<', i);
    if (openIdx === -1) return -1;
    const m = matchOpenTag(text, openIdx);
    if (m && knownTools.has(m.name)) return openIdx;
    i = openIdx + 1;
  }
  return -1;
}

/** Parse `<param>value</param>` blocks from the inner content of a tool tag. */
function parseParams(inner: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let i = 0;
  while (i < inner.length) {
    const openIdx = inner.indexOf('<', i);
    if (openIdx === -1) break;
    const m = matchOpenTag(inner, openIdx);
    if (!m) {
      i = openIdx + 1;
      continue;
    }
    const closeTag = `</${m.name}>`;
    const closeIdx = inner.indexOf(closeTag, m.afterOpen);
    if (closeIdx === -1) {
      i = openIdx + 1;
      continue;
    }
    const value = inner.slice(m.afterOpen, closeIdx);
    // Try to parse as JSON if it looks like JSON, else keep as string.
    args[m.name] = tryParseJson(value);
    i = closeIdx + closeTag.length;
  }
  return args;
}

function tryParseJson(s: string): unknown {
  const trimmed = s.trim();
  if (!trimmed) return s;
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
  }
  return s;
}
