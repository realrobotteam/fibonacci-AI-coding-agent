/**
 * Tool-call parser — supports BOTH formats:
 *
 *   1. XML (Cline-style):      <write_to_file><path>...</path><content>...</content></write_to_file>
 *   2. Hermes (Nous-style):    <|tool_call>call:write_to_file{path:"...",content:"..."}<tool_call|>
 *
 * The agent can be configured to emit either format. The Hermes format is
 * preferred when `fibonacci.hermesMode` is true (the model is trained to emit
 * this format natively). The XML format is the legacy default that works
 * reliably even with models that don't reliably populate `tool_calls`.
 *
 * Both parsers also extract `<|channel>thought\n...\n<channel|>` reasoning
 * blocks so the UI can show them as a collapsible "thinking" section.
 */

import { parseHermesToolCalls, parseHermesThinking } from './hermesTemplate';

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** The full block as it appeared in the text (for stripping). */
  raw: string;
}

export interface ParseToolCallsResult {
  calls: ParsedToolCall[];
  prose: string;
  /** Reasoning channel content (Hermes `<|channel>thought`) — empty if none. */
  thinking: string;
}

/** Top-level tool tag names we recognize (for the XML parser). */
export const KNOWN_TOOLS = new Set<string>([
  // File
  'read_file',
  'write_to_file',
  'replace_in_file',
  'list_files',
  'search_files',
  'get_active_editor',
  // Terminal
  'execute_command',
  'run_in_terminal',
  'get_command_output',
  // MCP
  'list_mcp_tools',
  'call_mcp_tool',
  'get_mcp_resources',
  'manage_mcp_servers',
  // Todo / mode
  'update_todos',
  'request_mode_switch',
  // New: web
  'web_fetch',
  'web_search',
  // New: search
  'grep_search',
  'glob_files',
  // New: git
  'git_status',
  'git_diff',
  'git_log',
  // New: editor
  'diagnostics',
  'format_code',
  'document_symbols',
  'workspace_symbols',
  'code_actions',
  'open_file',
  // New: code edit
  'insert_at_line',
  'delete_lines',
  'append_to_file',
  // New: reasoning / meta
  'think',
  'clarify',
  'delegate_task',
  'memory',
  'execute_code',
  // New: skills
  'list_skills',
  'view_skill',
  'invoke_skill',
]);

export function registerKnownTool(name: string): void {
  KNOWN_TOOLS.add(name);
}

/**
 * Parse all tool-call blocks (both XML and Hermes) from the assistant's text.
 * Returns the parsed calls plus the text with the blocks stripped, plus any
 * reasoning channel content.
 *
 * When `streaming` is true, incomplete blocks at the end of the text are
 * stripped from prose — they're still being streamed.
 */
export function parseToolCalls(
  text: string,
  options?: { streaming?: boolean }
): ParseToolCallsResult {
  const streaming = options?.streaming === true;

  // 1) Extract Hermes thinking channel first (it wraps the entire response
  //    when present). The thinking content is captured separately.
  const { prose: afterThinking, thinking } = parseHermesThinking(text);

  // 2) Parse Hermes tool calls from the post-thinking prose.
  const { calls: hermesCalls, prose: afterHermes } = parseHermesToolCalls(afterThinking);

  // 3) Parse XML tool calls from the same text.
  const { calls: xmlCalls, prose: afterXml } = parseXmlToolCalls(afterHermes, streaming);

  const calls = [...hermesCalls, ...xmlCalls];

  // Merge prose: prefer the longer of afterHermes/afterXml since one will be
  // a strict subset of the other.
  const prose =
    afterHermes.length >= afterXml.length ? afterHermes : afterXml;

  return { calls, prose, thinking };
}

/** XML-based tool-call parser (Cline-style). */
function parseXmlToolCalls(text: string, streaming: boolean): {
  calls: ParsedToolCall[];
  prose: string;
} {
  const calls: ParsedToolCall[] = [];
  let prose = '';

  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf('<', i);
    if (openIdx === -1) {
      prose += text.slice(i);
      break;
    }

    prose += text.slice(i, openIdx);

    const tagMatch = matchOpenTag(text, openIdx);
    if (!tagMatch) {
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    const { name, afterOpen } = tagMatch;
    if (!KNOWN_TOOLS.has(name)) {
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    const closeTag = `</${name}>`;
    const nextOpenIdx = findNextOpenTag(text, afterOpen, KNOWN_TOOLS);
    const closeIdx = text.indexOf(closeTag, afterOpen);
    if (closeIdx === -1) {
      if (streaming) break; // incomplete tool block
      prose += '<';
      i = openIdx + 1;
      continue;
    }
    if (nextOpenIdx !== -1 && nextOpenIdx < closeIdx) {
      prose += '<';
      i = openIdx + 1;
      continue;
    }

    const inner = text.slice(afterOpen, closeIdx);
    const raw = text.slice(openIdx, closeIdx + closeTag.length);

    const args = parseParams(inner);
    calls.push({ name, args, raw });
    i = closeIdx + closeTag.length;
  }

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
  if (text[i] !== '<' || !/[a-z_]/.test(text[i + 1] ?? '')) return null;
  let j = i + 1;
  while (j < text.length && /[a-z0-9_]/.test(text[j])) j++;
  const name = text.slice(i + 1, j);
  if (!name) return null;
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
