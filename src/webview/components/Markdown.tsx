import React from 'react';

/**
 * Minimal markdown renderer — handles code fences, inline code, bold, italic,
 * and paragraphs. Deliberately tiny to avoid pulling in a heavy dependency
 * inside the webview bundle. Code blocks render LTR even inside an RTL chat.
 */
export const Markdown: React.FC<{ content: string }> = ({ content }) => {
  const blocks = parseBlocks(content);
  return (
    <div className="prose text-text">
      {blocks.map((b, i) => {
        if (b.type === 'code') {
          return (
            <pre key={i}>
              <code>{b.content}</code>
            </pre>
          );
        }
        if (b.type === 'para') {
          return <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(b.content) }} />;
        }
        return null;
      })}
    </div>
  );
};

type Block =
  | { type: 'code'; lang?: string; content: string }
  | { type: 'para'; content: string };

function parseBlocks(input: string): Block[] {
  const lines = input.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
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
    } else if (line.trim() === '') {
      i++;
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'para', content: buf.join('\n') });
    }
  }
  return blocks;
}

function renderInline(text: string): string {
  // Escape HTML first
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" class="text-text-link" target="_blank" rel="noreferrer">$1</a>'
  );
  // Newlines → <br/>
  s = s.replace(/\n/g, '<br/>');
  return s;
}
