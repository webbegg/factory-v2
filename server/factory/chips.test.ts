// The round chips on a board card: gate first, then the routed reviewers once
// the gate passed. A chip whose step is executing right now, in a job the
// factory is running, is `running`; reviewers run one at a time.
import { describe, expect, test } from 'bun:test'
import { roundChips } from '../../app/utils/chips'
import { makeEnv, newJob } from './testing'

const env = await makeEnv()
const job = (f: Parameters<typeof newJob>[1]) => newJob(env, {
  round: 1,
  agents: { reviewers: { code: 'sonnet', ux: 'sonnet', security: 'opus' } },
  ...f
})
const states = (f: Parameters<typeof newJob>[1], live = true) => roundChips(job(f), live).map(c => `${c.label}:${c.state}`)

describe('roundChips', () => {
  test('no round yet, no chips', () => {
    expect(roundChips(job({ round: 0, stage: 'spec' }), true)).toEqual([])
  })

  test('while building, the gate waits', () => {
    expect(states({ stage: 'build', gate: null })).toEqual(['gate:pending'])
  })

  test('the gate runs during the gate stage', () => {
    expect(states({ stage: 'gate', gate: null })).toEqual(['gate:running'])
  })

  test('a gate stage the factory is not running waits', () => {
    expect(states({ stage: 'gate', gate: null }, false)).toEqual(['gate:pending'])
  })

  test('a failed gate shows no reviewers', () => {
    expect(states({ stage: 'build', round: 2, gate: 'FAIL' })).toEqual(['gate:FAIL'])
  })

  test('in review, the first reviewer without a verdict runs and later ones wait, in routing order', () => {
    expect(states({ stage: 'review', gate: 'PASS', reviews: { code: 'PASS', ux: 'pending', security: 'pending' } }))
      .toEqual(['gate:PASS', 'code:PASS', 'ux:running', 'sec:pending'])
  })

  test('reviewers run one at a time: only the first without a verdict runs', () => {
    expect(states({ stage: 'review', gate: 'PASS', reviews: {} }))
      .toEqual(['gate:PASS', 'code:running', 'ux:pending', 'sec:pending'])
  })

  test('in a review the factory is not running, missing verdicts wait', () => {
    expect(states({ stage: 'review', gate: 'PASS', reviews: { code: 'PASS', ux: 'pending', security: 'CHANGES' } }, false))
      .toEqual(['gate:PASS', 'code:PASS', 'ux:pending', 'sec:CHANGES'])
  })

  test('outside review, a missing verdict waits instead of running', () => {
    expect(states({ stage: 'needs-human', gate: 'PASS', reviews: { code: 'PASS' } }))
      .toEqual(['gate:PASS', 'code:PASS', 'ux:pending', 'sec:pending'])
  })

  test('an unreadable verdict is invalid', () => {
    expect(states({ stage: 'approve', gate: 'PASS', reviews: { code: 'invalid', ux: 'PASS', security: 'PASS' } }))
      .toEqual(['gate:PASS', 'code:invalid', 'ux:PASS', 'sec:PASS'])
  })
})
