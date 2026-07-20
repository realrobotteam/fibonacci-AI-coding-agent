import type { ToolDefinition } from '../types';
import { schema } from '../core/toolRegistry';
import type { ToolRegistry } from '../core/toolRegistry';

/**
 * Web tools:
 *  - web_fetch: fetch a URL and return cleaned text/markdown
 *  - web_search: web search (uses a configurable search backend)
 *
 * Both are read-only and auto-approved.
 */

export const webToolDefinitions: ToolDefinition[] = [
  {
    name: 'web_fetch',
    category: 'web',
    description:
      'Fetch a URL and return the response body as cleaned text. HTML pages are stripped to their text content with tags removed. JSON is returned as pretty-printed JSON. Other content types are returned as-is (truncated to max_length). Useful for reading documentation, API responses, or any public web page.',
    parameters: schema(
      {
        url: { type: 'string', description: 'The URL to fetch (http:// or https://)' },
        max_length: {
          type: 'number',
          description: 'Maximum characters to return (default: 20000)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 15000)',
        },
      },
      ['url']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['web', 'read'],
  },
  {
    name: 'web_search',
    category: 'web',
    description:
      'Search the web for a query and return up to max_results results (title, URL, snippet). Useful for finding documentation, error messages, package info, or current information beyond your training cutoff.',
    parameters: schema(
      {
        query: { type: 'string', description: 'Search query' },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 10)',
        },
      },
      ['query']
    ),
    requiresApproval: false,
    readOnly: true,
    tags: ['web', 'search'],
  },
];

export function registerWebTools(registry: ToolRegistry): void {
  registry.register(webToolDefinitions[0], async (args, ctx) => {
    const url = String(args.url);
    const maxLength = Number(args.max_length ?? 20000);
    const timeout = Number(args.timeout ?? 15000);

    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        output: `Invalid URL: must start with http:// or https:// (got: ${url})`,
      };
    }

    // Block requests to private/internal IP ranges (SSRF protection)
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        /^10\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^169\.254\./.test(hostname)
      ) {
        return {
          ok: false,
          output: `Blocked: requests to private/internal addresses are not allowed (SSRF protection). Hostname: ${hostname}`,
        };
      }
    } catch {
      // URL parsing failed — already caught by the https? check above
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      ctx?.signal?.addEventListener('abort', () => controller.abort());

      const resp = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; FibonacciAgent/1.0; +https://fibonacci.monster)',
          Accept: 'text/html,application/json,text/plain,text/markdown,*/*',
        },
      });
      clearTimeout(timer);

      if (!resp.ok) {
        return {
          ok: false,
          output: `HTTP ${resp.status} ${resp.statusText} for ${url}`,
        };
      }

      const contentType = resp.headers.get('content-type') ?? '';
      const text = await resp.text();
      let cleaned: string;

      if (contentType.includes('application/json')) {
        try {
          cleaned = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          cleaned = text;
        }
      } else if (contentType.includes('text/html')) {
        cleaned = htmlToText(text);
      } else {
        cleaned = text;
      }

      const truncated = cleaned.length > maxLength;
      const result = truncated ? cleaned.slice(0, maxLength) + '\n[...truncated...]' : cleaned;

      return {
        ok: true,
        output: `[${resp.status} ${contentType || 'unknown'}] ${url}\n\n${result}`,
        meta: {
          url,
          status: resp.status,
          contentType,
          length: cleaned.length,
          truncated,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Fetch failed for ${url}: ${msg}` };
    }
  });

  registry.register(webToolDefinitions[1], async (args, ctx) => {
    const query = String(args.query);
    const maxResults = Math.min(10, Math.max(1, Number(args.max_results ?? 5)));

    // We don't ship a search backend; instead, we use a public search API
    // (DuckDuckGo's HTML endpoint) and parse the results. This is a best-effort
    // implementation — for production use, configure a proper search API key.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      ctx?.signal?.addEventListener('abort', () => controller.abort());

      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; FibonacciAgent/1.0; +https://fibonacci.monster)',
        },
      });
      clearTimeout(timer);

      if (!resp.ok) {
        return {
          ok: false,
          output: `Search failed: HTTP ${resp.status} ${resp.statusText}`,
        };
      }

      const html = await resp.text();
      const results = parseDuckDuckGoHtml(html, maxResults);

      if (results.length === 0) {
        return {
          ok: true,
          output: `No results found for: ${query}`,
        };
      }

      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      );
      return {
        ok: true,
        output: `[search: ${query}]\n\n${lines.join('\n\n')}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Search error: ${msg}` };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Very simple HTML-to-text conversion: strip tags, decode entities, collapse whitespace. */
function htmlToText(html: string): string {
  // Remove script and style blocks entirely
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  // Replace block-level tags with newlines
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|ul|ol|table)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '');
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  // DuckDuckGo HTML results have anchors with class "result__a" and snippets
  // with class "result__snippet". We use regex (best-effort).
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < max) {
    const rawUrl = m[1];
    const title = stripTags(m[2]).trim();
    const snippet = stripTags(m[3]).trim();
    // DuckDuckGo redirects through /l/?uddg=...
    let url = rawUrl;
    const u = rawUrl.match(/uddg=([^&]+)/);
    if (u) {
      try {
        url = decodeURIComponent(u[1]);
      } catch {
        /* keep raw */
      }
    }
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
