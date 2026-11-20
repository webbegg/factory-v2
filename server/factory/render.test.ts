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
