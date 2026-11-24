// Feedback that reads like an approval gets a "Did you mean Merge?" before it is sent.
import { describe, expect, test } from 'bun:test'
import { looksLikeApproval } from '../../app/utils/decision'

describe('looksLikeApproval', () => {
  test.each([
    'go on, merge PR',
    'I merged the PR, go on',
    'PR is merged',
    'LGTM',
    'go with your recommendations. Merge'
  ])('matches %p', (text) => {
    expect(looksLikeApproval(text)).toBe(true)
  })

  test.each([
    'emerge',
    'merger',
    'fix the typo in the header',
    ''
  ])('does not match %p', (text) => {
    expect(looksLikeApproval(text)).toBe(false)
  })
})
