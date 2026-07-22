import React from 'react';

/**
 * Enhanced markdown renderer — supports headings (H1-H6), lists, code blocks 
 * with syntax highlighting, tables, bold/italic, inline code, links.
 * Code blocks render LTR even inside an RTL chat.
 */
export const Markdown: React.FC<{ content: string }> = ({ content }) => {
  const blocks = parseBlocks(content);
  return (
    <div className="prose text-text">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <pre key={i} className={`language-${b.lang || ''}`}>
                <code className={`language-${b.lang || ''}`}>{b.content}</code>
              </pre>
            );
          case 'heading':
            return (
              <React.Fragment key={i}>
                {renderHeading(b.level, b.content)}
              </React.Fragment>
            );
          case 'table':
            return <Table key={i} header={b.header} rows={b.rows} />;
          case 'list':
            return <List key={i} items={b.items} ordered={b.ordered} />;
          case 'para':
            return <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(b.content) }} />;
          case 'hr':
            return <hr key={i} className="my-4 border-border-subtle" />;
          case 'blockquote':
            return <blockquote key={i} className="border-r-2 border-brand pr-3 my-2 text-text-secondary italic" dangerouslySetInnerHTML={{ __html: renderInline(b.content) }} />;
          default:
            return null;
        }
      })}
    </div>
  );
};

type Block =
  | { type: 'code'; lang?: string; content: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'list'; items: string[]; ordered: boolean }
  | { type: 'para'; content: string }
  | { type: 'hr' }
  | { type: 'blockquote'; content: string };

function parseBlocks(input: string): Block[] {
  const lines = input.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    const fence = line.match(/^```(\w+)?/);
    if (fence) {
      const lang = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, content: buf.join('\n') });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      blocks.push({ type: 'heading', level, content });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].slice(1).trimStart());
        i++;
      }
      blocks.push({ type: 'blockquote', content: buf.join('\n') });
      continue;
    }

    // Table
    if (line.includes('|') && lines[i + 1]?.match(/^\s*\|?\s*:?-+:?\s*\|/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = parseTable(tableLines);
      if (parsed) blocks.push({ type: 'table', ...parsed });
      continue;
    }

    // List
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const marker = listMatch[2];
      const ordered = /^\d+\.$/.test(marker);
      const items: string[] = [];
      let listIndent = indent;
      
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(new RegExp(`^\\s{0,${listIndent}}([-*+]|\\d+\\.)\\s+(.+)$`));
        if (m) {
          items.push(m[2]);
          i++;
        } else if (l.trim() === '') {
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', items, ordered });
      continue;
    }

    // Paragraph
    if (line.trim() !== '') {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && 
             !lines[i].startsWith('```') &&
             !lines[i].match(/^(#{1,6})\s+/) &&
             !/^---+$/.test(lines[i].trim()) &&
             !/^\*\*\*+$/.test(lines[i].trim()) &&
             !lines[i].startsWith('>') &&
             !lines[i].match(/^\s*([-*+]|\d+\.)\s+/) &&
             !(lines[i].includes('|') && lines[i + 1]?.match(/^\s*\|?\s*:?-+:?\s*\|/))) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'para', content: buf.join('\n') });
      continue;
    }

    i++;
  }

  return blocks;
}

function parseTable(lines: string[]): { header: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;
  
  const parseRow = (line: string) => 
    line.split('|').map(c => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
  
  const header = parseRow(lines[0]);
  if (header.length === 0) return null;
  
  // Skip separator line
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === header.length) rows.push(row);
  }
  
  return { header, rows };
}

const Table: React.FC<{ header: string[]; rows: string[][] }> = ({ header, rows }) => (
  <div className="overflow-x-auto my-3">
    <table className="min-w-full border-collapse border border-border-subtle">
      <thead>
        <tr>
          {header.map((h, i) => (
            <th key={i} className="border border-border-subtle px-2 py-1 text-xs font-semibold text-text-primary bg-input text-left">
              {renderInline(h)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri} className={ri % 2 === 0 ? 'bg-input/30' : ''}>
            {row.map((cell, ci) => (
              <td key={ci} className="border border-border-subtle px-2 py-1 text-xs text-text-secondary text-left">
                {renderInline(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const List: React.FC<{ items: string[]; ordered: boolean }> = ({ items, ordered }) => (
  <ul className={`my-2 ps-5 space-y-1 ${ordered ? 'list-decimal' : 'list-disc'}`}>
    {items.map((item, i) => (
      <li key={i} className="text-sm text-text-secondary" dangerouslySetInnerHTML={{ __html: renderInline(item) }} />
    ))}
  </ul>
);

function renderHeading(level: number, content: string): React.ReactElement {
  const Tag = `h${Math.min(6, Math.max(1, level))}` as keyof JSX.IntrinsicElements;
  const classNames = {
    1: 'text-2xl font-bold my-3',
    2: 'text-xl font-bold my-3',
    3: 'text-lg font-bold my-2',
    4: 'text-base font-bold my-2',
    5: 'text-sm font-bold my-1',
    6: 'text-xs font-bold my-1',
  };
  return React.createElement(Tag, { className: classNames[level as keyof typeof classNames], dangerouslySetInnerHTML: { __html: renderInline(content) } });
}

function renderInline(text: string): string {
  // Escape HTML first
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Images
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" class="max-w-full h-auto rounded my-2" />'
  );

  // Links
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" class="text-brand hover:underline" target="_blank" rel="noreferrer">$1</a>'
  );

  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code class="bg-input px-1 rounded text-sm font-mono">$1</code>');

  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Strikethrough
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Newlines → <br/>
  s = s.replace(/\n/g, '<br/>');

  return s;
}