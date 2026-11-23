// What waits on the operator: needs-human and stalled jobs, each once. needs-info
// waits on the issue's author, so it counts only when the job also stalled.
import { describe, expect, test } from 'bun:test'
import { newlyWaiting, pageTitle, waitingCount, waitingOnYou, waitingReasons } from '../../app/utils/waiting'
import { makeEnv, newJob } from './testing'
import type { Stage } from './types'

const env = await makeEnv()
const job = (id: string, stage: Stage) => newJob(env, { id, stage })
const ids = (jobs: { id: string }[]) => jobs.map(j => j.id)

describe('waitingOnYou', () => {
  test('needs-human counts', () => {
    const jobs = [job('001-a', 'needs-human')]
    expect(ids(waitingOnYou(jobs, {}))).toEqual(['001-a'])
    expect(waitingCount(jobs, {})).toBe(1)
  })

  test('stalled counts in any stage', () => {
    const jobs = [job('001-a', 'build'), job('002-b', 'review')]
    expect(ids(waitingOnYou(jobs, { '001-a': 'boom', '002-b': 'bang' }))).toEqual(['001-a', '002-b'])
  })

  test('needs-info alone does not count', () => {
    expect(waitingCount([job('001-a', 'needs-info')], {})).toBe(0)
  })

  test('needs-info and stalled counts once', () => {
    expect(waitingCount([job('001-a', 'needs-info')], { '001-a': 'boom' })).toBe(1)
  })

  test('needs-human and stalled counts once', () => {
    const jobs = [job('001-a', 'needs-human')]
    expect(ids(waitingOnYou(jobs, { '001-a': 'boom' }))).toEqual(['001-a'])
    expect(waitingReasons(jobs, { '001-a': 'boom' })).toEqual({ '001-a': 'stalled' })
  })

  test('other stages do not count', () => {
    expect(waitingCount([job('001-a', 'build'), job('002-b', 'merged'), job('003-c', 'rejected')], {})).toBe(0)
  })

  test('keeps the jobs order', () => {
    const jobs = [job('001-a', 'build'), job('002-b', 'needs-human'), job('003-c', 'spec')]
    expect(ids(waitingOnYou(jobs, { '003-c': 'x', '001-a': 'y' }))).toEqual(['001-a', '002-b', '003-c'])
  })
})

describe('pageTitle', () => {
  test('no count when nothing waits', () => {
    expect(pageTitle(0)).toBe('Factory')
  })

  test('the count first otherwise', () => {
    expect(pageTitle(2)).toBe('(2) Factory')
  })
})

describe('newlyWaiting', () => {
  test('nothing changed, nothing new', () => {
    const reasons = { '001-a': 'needs-human', '002-b': 'stalled' } as const
    expect(newlyWaiting(reasons, { ...reasons })).toEqual([])
  })

  test('a new id is new', () => {
    expect(newlyWaiting({ '001-a': 'needs-human' }, { '001-a': 'needs-human', '002-b': 'stalled' }))
      .toEqual([{ id: '002-b', reason: 'stalled' }])
  })

  test('a reason change from needs-human to stalled is new', () => {
    expect(newlyWaiting({ '001-a': 'needs-human' }, { '001-a': 'stalled' }))
      .toEqual([{ id: '001-a', reason: 'stalled' }])
  })

  test('a job that left is not new', () => {
    expect(newlyWaiting({ '001-a': 'needs-human' }, {})).toEqual([])
  })
})
