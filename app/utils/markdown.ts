// A small markdown renderer for the agents' files. Everything is escaped first
// and only a fixed set of tags is produced, because the files quote issue text
// from anyone on GitHub.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ESC[c]!)
}

function inline(raw: string): string {
  const codes: string[] = []
  const spans: string[] = []
  let s = raw.replace(/`([^`]+)`/g, (span: string, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    spans.push(span)
    return `\u0000${codes.length - 1}\u0000`
  })
  // images are stashed like code so the bold and link rules never rewrite the
  // tag; a code span in the alt goes back to its plain text
  // eslint-disable-next-line no-control-regex
  s = s.replace(/!\[([^\]]*)\]\((https:\/\/[^\s)\u0000]+)\)/g, (_, alt: string, url: string) => {
    // eslint-disable-next-line no-control-regex
    const text = alt.replace(/\u0000(\d+)\u0000/g, (_, i: string) => spans[Number(i)]!)
    codes.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}" loading="lazy">`)
    spans.push('')
    return `\u0000${codes.length - 1}\u0000`
  })
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!)
}

function listItem(text: string): string {
  return inline(text.replace(/^\[x\]\s/i, '☑ ').replace(/^\[ \]\s/, '☐ '))
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!)
      i++
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`)
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(`<li>${listItem(lines[i++]!.replace(/^\s*[-*]\s+/, ''))}</li>`)
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) items.push(`<li>${listItem(lines[i++]!.replace(/^\s*\d+\.\s+/, ''))}</li>`)
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|>|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i]!)) para.push(lines[i++]!)
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('\n')
}

/** Splits an agent file into its verdict header, its `## Summary` and the rest. */
export function splitSummary(src: string): { head: string, summary: string | null, rest: string } {
  let text = src.trim()
  let head = ''
  const blank = text.indexOf('\n\n')
  const first = blank < 0 ? text : text.slice(0, blank)
  // a header is verdict lines like `APPROVE`, `GATE: PASS` or `RISK: low`
  if (first.split('\n').every(l => /^[A-Z][A-Z-]*(:\s.*)?$/.test(l.trim()))) {
    head = first.trim()
    text = blank < 0 ? '' : text.slice(blank + 2).trim()
  }
  const m = /^## Summary\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)
  if (!m) return { head, summary: null, rest: text }
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()
  return { head, summary: m[1]!.trim(), rest }
}
