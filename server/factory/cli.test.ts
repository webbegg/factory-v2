import { describe, expect, test } from 'bun:test'
import { table } from './cli'
import { makeEnv, newJob } from './testing'

describe('status table', () => {
  test('one aligned row per job and an estimated total', async () => {
    const env = await makeEnv()
    const a = newJob(env, { id: '001-a', issue: 1, stage: 'merged', round: 1, pr: 7, costUsd: 0.5, ended: '2026-11-20T11:04:00Z' })
    const b = newJob(env, { id: '002-longer', issue: 12, stage: 'needs-human', round: 3, costUsd: 1.25, ended: '2026-11-20T12:30:00Z' })
    expect(table([a, b])).toBe([
      'job         issue  stage        round  pr  cost   time',
      '001-a       #1     merged       1      #7  $0.50  4m',
      '002-longer  #12    needs-human  3      -   $1.25  1h30m',
      'total $1.75 (API-equivalent estimate, factory agents only)'
    ].join('\n'))
  })
})
