// The board renders agents' markdown, which quotes issue text from anyone on
// GitHub, so the renderer must never pass HTML through.
import { describe, expect, test } from 'bun:test'
import { renderMarkdown, splitSummary } from '../../app/utils/markdown'

describe('renderMarkdown', () => {
  test('escapes raw HTML everywhere, including in quotes, code and links', () => {
    const html = renderMarkdown('> <img src=x onerror=alert(1)>\n\n`<b>`\n\n```\n<script>x</script>\n```\n\n[a](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('href="javascript')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('headings, lists, checkboxes, quotes, code and emphasis', () => {
    const html = renderMarkdown('## Scope\n- **one** and `two`\n- [x] done\n1. first\n\n> quoted\n\n```\ncode\n```')
    expect(html).toContain('<h2>Scope</h2>')
    expect(html).toContain('<ul><li><strong>one</strong> and <code>two</code></li><li>☑ done</li></ul>')
    expect(html).toContain('<ol><li>first</li></ol>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<pre><code>code</code></pre>')
  })

  test('http links open safely', () => {
    expect(renderMarkdown('[PR](https://github.com/o/r/pull/1)'))
      .toContain('<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener noreferrer">PR</a>')
  })

  test('https images render with only src, alt and lazy loading', () => {
    expect(renderMarkdown('![screenshot-1](https://x.test/p.png)'))
      .toBe('<p><img src="https://x.test/p.png" alt="screenshot-1" loading="lazy"></p>')
    expect(renderMarkdown('![](https://x.test/p.png)')).toBe('<p><img src="https://x.test/p.png" alt="" loading="lazy"></p>')
  })

  test('image alt and URL are escaped and cannot leave their attribute', () => {
    expect(renderMarkdown('![a"<](https://x.test/p.png)')).toContain('<img src="https://x.test/p.png" alt="a&quot;&lt;" loading="lazy">')
    expect(renderMarkdown('![x"<>&\'](https://x.test/p.png)')).toContain('alt="x&quot;&lt;&gt;&amp;&#39;"')
    expect(renderMarkdown('![a](https://x.test/"onerror="alert(1).png)'))
      .toBe('<p><img src="https://x.test/&quot;onerror=&quot;alert(1" alt="a" loading="lazy">.png)</p>')
    expect(renderMarkdown('![**b**](https://x.test/p.png)')).toBe('<p><img src="https://x.test/p.png" alt="**b**" loading="lazy"></p>')
  })

  test('a NUL placeholder in the input cannot put stashed HTML inside a link URL', () => {
    const html = renderMarkdown('![a](https://x/onmouseover=alert%281%29//) [x](https://a\u00000\u0000) [y](https://b\u00001\u0000) `c`')
    expect(html).not.toContain('\u0000')
    expect(html).not.toMatch(/href="[^"]*</)
    expect(html).toBe('<p><img src="https://x/onmouseover=alert%281%29//" alt="a" loading="lazy"> <a href="https://a0" target="_blank" rel="noopener noreferrer">x</a> <a href="https://b1" target="_blank" rel="noopener noreferrer">y</a> <code>c</code></p>')
  })

  test('images with any other URL stay escaped text', () => {
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://x.test/p.png', '//x.test/p.png', 'p.png']) {
      const html = renderMarkdown(`![a](${url})`)
      expect(html).not.toContain('<img')
      expect(html.startsWith('<p>!')).toBe(true)
    }
  })

  test('images nest inside links, quotes and list items, and stay code in backticks', () => {
    expect(renderMarkdown('[![a](https://x.test/i.png)](https://x.test/l)'))
      .toBe('<p><a href="https://x.test/l" target="_blank" rel="noopener noreferrer"><img src="https://x.test/i.png" alt="a" loading="lazy"></a></p>')
    expect(renderMarkdown('> ![a](https://x.test/i.png)')).toBe('<blockquote><p><img src="https://x.test/i.png" alt="a" loading="lazy"></p></blockquote>')
    expect(renderMarkdown('- ![a](https://x.test/i.png)')).toBe('<ul><li><img src="https://x.test/i.png" alt="a" loading="lazy"></li></ul>')
    expect(renderMarkdown('`![a](https://x.test/i.png)`')).toBe('<p><code>![a](https://x.test/i.png)</code></p>')
    expect(renderMarkdown('```\n![a](https://x.test/i.png)\n```')).toBe('<pre><code>![a](https://x.test/i.png)</code></pre>')
    expect(renderMarkdown('![`c`](https://x.test/i.png)')).toBe('<p><img src="https://x.test/i.png" alt="`c`" loading="lazy"></p>')
  })
})

describe('splitSummary', () => {
  test('separates the verdict header and the Summary section from the rest', () => {
    const s = splitSummary('VERDICT: PASS\n\n## Summary\n- a\n- b\n\n## Findings\nNone.\n')
    expect(s).toEqual({ head: 'VERDICT: PASS', summary: '- a\n- b', rest: '## Findings\nNone.' })
    expect(splitSummary('# Spec\n\n## Context\nx')).toEqual({ head: '', summary: null, rest: '# Spec\n\n## Context\nx' })
    expect(splitSummary('DECISION: ACCEPT\nRISK: low\n\n## Scope\nx').head).toBe('DECISION: ACCEPT\nRISK: low')
    expect(splitSummary('ESCALATE\n\n## Why\nx').head).toBe('ESCALATE')
    // a plain snippet has no header
    expect(splitSummary('1. Allow tests in a new file, or\n2. Unprotect it.')).toEqual({ head: '', summary: null, rest: '1. Allow tests in a new file, or\n2. Unprotect it.' })
  })
})
