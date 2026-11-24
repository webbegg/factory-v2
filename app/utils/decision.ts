// Helpers for the needs-human panel; no Vue imports, so `bun test` covers them.

const APPROVAL = [/\bmerge(d)?\b/i, /\bgo on\b/i, /\blgtm\b/i]

/** Feedback that reads like an approval: the panel asks "Did you mean Merge?" before sending it. */
export function looksLikeApproval(text: string): boolean {
  return APPROVAL.some(re => re.test(text))
}
