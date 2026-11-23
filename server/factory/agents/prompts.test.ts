// Each reviewer blocks only on its own lens's problems; these phrases are the
// contract, so dropping or mixing a rule in a later edit fails here.
import { describe, expect, test } from 'bun:test'
import { PROMPTS } from './prompts'

const LENS_RULES = {
  'reviewer-code': 'bugs, spec gaps, weakened tests, clear convention breaks',
  'reviewer-ui': 'visible inconsistencies or breakage',
  'reviewer-ux': 'problems a user would actually hit, in scope',
  'reviewer-security': 'an exploitable issue the branch adds'
} as const

const REVIEWERS = Object.keys(LENS_RULES) as (keyof typeof LENS_RULES)[]

// Prompts wrap at ~80 columns, so phrases are matched across line breaks.
const flat = (name: keyof typeof PROMPTS) => PROMPTS[name].replace(/\s+/g, ' ')

describe('reviewer prompts', () => {
  for (const reviewer of REVIEWERS) {
    test(`${reviewer} states only its own CHANGES rule`, () => {
      const prompt = flat(reviewer)
      expect(prompt).toContain(`CHANGES only for ${LENS_RULES[reviewer]}`)
      for (const other of REVIEWERS.filter(r => r !== reviewer)) {
        expect(prompt).not.toContain(LENS_RULES[other])
      }
      expect(prompt).not.toContain('CHANGES only for real, in-scope problems')
    })

    test(`${reviewer} has a Spec conflicts section and sticky earlier Notes`, () => {
      const prompt = flat(reviewer)
      expect(prompt).toContain('## Spec conflicts')
      expect(prompt).toContain('read both its Findings and its Notes')
      expect(prompt).toContain('only if the commits since that review touched it')
    })
  }
})

describe('approver prompt', () => {
  test('escalates real spec conflicts', () => {
    expect(flat('approver')).toContain('## Spec conflicts')
    expect(flat('approver')).toContain('no Spec conflict describes a real problem')
    expect(flat('approver')).toMatch(/Spec conflict[^.]*real problem, ESCALATE/)
  })
})

describe('builder prompt', () => {
  test('never reformats whole files, even resolving merge conflicts', () => {
    expect(flat('builder')).toContain('never reformat whole files, including when resolving a merge conflict')
  })
})
