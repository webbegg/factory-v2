import { describe, expect, test } from 'bun:test'
import { body, firstLine, header, section } from './markdown'

const doc = 'VERDICT: CHANGES\nCOMMIT: abc\n\n## Summary\n- one\n\n## Findings\n1. bug\n\n## Notes\nnone\n'

describe('markdown', () => {
  test('header reads KEY: value lines up to the first blank line, keys upper-cased', () => {
    expect(header(doc)).toEqual({ VERDICT: 'CHANGES', COMMIT: 'abc' })
    expect(header('decision: accept\nRisk: low\n\nRISK: high')).toEqual({ DECISION: 'accept', RISK: 'low' })
  })

  test('section returns the body of a ## heading, or null', () => {
    expect(section(doc, 'Findings')).toBe('1. bug')
    expect(section(doc, 'Notes')).toBe('none')
    expect(section(doc, 'Missing')).toBeNull()
  })

  test('firstLine trims and handles empty text', () => {
    expect(firstLine('  APPROVE  \nrest')).toBe('APPROVE')
    expect(firstLine('')).toBe('')
  })

  test('body is everything after the header block', () => {
    expect(body('A: 1\nB: 2\n\n## Summary\n- x\n')).toBe('## Summary\n- x')
    expect(body('ESCALATE\n\n## Why\nbecause\n')).toBe('## Why\nbecause')
  })
})
