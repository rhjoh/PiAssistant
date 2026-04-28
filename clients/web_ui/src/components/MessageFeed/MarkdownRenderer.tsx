type MarkdownBlock =
  | { type: 'paragraph'; content: InlineSegment[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'heading'; level: number; content: InlineSegment[] }
  | { type: 'list'; items: InlineSegment[][] };

type InlineSegment = {
  type: 'text' | 'bold' | 'code' | 'link';
  content: string;
  url?: string;
};

export function MarkdownContent({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <div style={{ fontFamily: 'var(--font-secondary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, key: number): React.ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre
          key={key}
          className="scrollbar-hide"
          style={{
            margin: '12px 0',
            padding: '12px 16px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color-strong)',
            borderRadius: '0',
            maxWidth: '100%'
          }}
        >
          {block.language && (
            <div style={{
              fontSize: '10px',
              color: 'var(--text-secondary)',
              textTransform: 'uppercase',
              marginBottom: '8px',
              fontFamily: 'var(--font-primary)',
              fontWeight: 500
            }}>
              {block.language}
            </div>
          )}
          <code
            className="text-wrap-hard"
            style={{
              fontSize: '13px',
              lineHeight: '1.6',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-primary)',
            }}
          >
            {block.code}
          </code>
        </pre>
      );

    case 'heading':
      const headingSize = block.level === 1 ? '24px' : block.level === 2 ? '20px' : '17px';
      return (
        <h3
          key={key}
          style={{
            fontSize: headingSize,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '16px 0 12px 0',
            fontFamily: 'var(--font-secondary)'
          }}
        >
          {renderInline(block.content)}
        </h3>
      );

    case 'list':
      return (
        <ul key={key} style={{ margin: '12px 0', paddingLeft: '20px' }}>
          {block.items.map((item, idx) => (
            <li key={idx} style={{ margin: '4px 0', color: 'var(--ai-text)' }}>
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );

    case 'paragraph':
    default:
      return (
        <p key={key} style={{ margin: '12px 0', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
          {renderInline(block.content)}
        </p>
      );
  }
}

function renderInline(segments: InlineSegment[]): React.ReactNode[] {
  return segments.map((seg, i) => {
    if (seg.type === 'bold') {
      return <strong key={i} style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{seg.content}</strong>;
    }
    if (seg.type === 'code') {
      return (
        <code
          key={i}
          style={{
            padding: '2px 6px',
            background: 'var(--bg-input)',
            borderRadius: '0',
            fontSize: '13px',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-primary)'
          }}
        >
          {seg.content}
        </code>
      );
    }
    if (seg.type === 'link') {
      return (
        <a
          key={i}
          href={seg.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: 'var(--accent-info)',
            textDecoration: 'underline',
            cursor: 'pointer'
          }}
        >
          {seg.content}
        </a>
      );
    }
    return <span key={i}>{seg.content}</span>;
  });
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const fence = line.match(/^```(\w*)/);
      const language = fence ? fence[1] : '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: parseInline(headingMatch[2])
      });
      i++;
      continue;
    }

    if (line.match(/^[-*]\s/)) {
      const items: InlineSegment[][] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        items.push(parseInline(lines[i].replace(/^[-*]\s+/, '')));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') && !lines[i].match(/^(#{1,6})\s/) && !lines[i].match(/^[-*]\s/)) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', content: parseInline(paraLines.join('\n')) });
  }

  return blocks;
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const urlMatch = remaining.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);

    type MatchType = { type: 'bold' | 'code' | 'link' | 'url'; index: number; end: number; content: string; url?: string };
    let earliestMatch: MatchType | null = null;

    if (codeMatch && codeMatch.index !== undefined) {
      earliestMatch = { type: 'code', index: codeMatch.index, end: codeMatch.index + codeMatch[0].length, content: codeMatch[1] };
    }
    if (boldMatch && boldMatch.index !== undefined) {
      if (!earliestMatch || boldMatch.index < earliestMatch.index) {
        earliestMatch = { type: 'bold', index: boldMatch.index, end: boldMatch.index + boldMatch[0].length, content: boldMatch[1] };
      }
    }
    if (linkMatch && linkMatch.index !== undefined) {
      if (!earliestMatch || linkMatch.index < earliestMatch.index) {
        earliestMatch = { type: 'link', index: linkMatch.index, end: linkMatch.index + linkMatch[0].length, content: linkMatch[1], url: linkMatch[2] };
      }
    }
    if (urlMatch && urlMatch.index !== undefined) {
      if (!earliestMatch || urlMatch.index < earliestMatch.index) {
        earliestMatch = { type: 'url', index: urlMatch.index, end: urlMatch.index + urlMatch[0].length, content: urlMatch[0], url: urlMatch[0] };
      }
    }

    if (earliestMatch && earliestMatch.index > 0) {
      segments.push({ type: 'text', content: remaining.slice(0, earliestMatch.index) });
    }

    if (earliestMatch) {
      if (earliestMatch.type === 'url') {
        segments.push({ type: 'link', content: earliestMatch.content, url: earliestMatch.url });
      } else {
        segments.push({ type: earliestMatch.type, content: earliestMatch.content, url: earliestMatch.url });
      }
      remaining = remaining.slice(earliestMatch.end);
    } else {
      segments.push({ type: 'text', content: remaining });
      break;
    }
  }

  return segments;
}
