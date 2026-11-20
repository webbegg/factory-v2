import { describe, expect, test } from 'bun:test'
import { MARKER } from './issue'
import { makeEnv, seed } from './testing'

const rows = (r: Array<{ action: string, issue: number }>) => r.map(x => `${x.action} #${x.issue}`)

describe('queue', () => {
  test('new issues fill the free slots in issue order; the rest hold', async () => {
    const env = await makeEnv({ concurrency: 2 })
    for (const n of [3, 1, 2]) env.github.addIssue({ number: n })
    env.github.addIssue({ number: 4, labels: [] })
    expect(rows(await env.queue.rows())).toEqual(['new #1', 'new #2', 'hold #3'])
  })

  test('running jobs resume and hold their slot', async () => {
    const env = await makeEnv({ concurrency: 2 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2 })
    env.github.addIssue({ number: 3 })
    await seed(env, { id: '001-a', issue: 2, stage: 'build', round: 1 })
    const r = await env.queue.rows()
    expect(rows(r)).toEqual(['resume #2', 'new #1', 'hold #3'])
    expect(r[0]).toMatchObject({ job: '001-a', stage: 'build', note: 'round 1' })
  })

  test('needs-info resumes once the author replied, and takes a slot', async () => {
    const env = await makeEnv({ concurrency: 1 })
    const q = { author: 'operator', body: `${MARKER}\nWhich colour?`, createdAt: '1' }
    env.github.addIssue({ number: 1, comments: [q, { author: 'alice', body: 'Blue.', createdAt: '2' }] })
    env.github.addIssue({ number: 2, comments: [q] })
    env.github.addIssue({ number: 3 })
    await seed(env, { id: '001-a', issue: 1, stage: 'needs-info' })
    await seed(env, { id: '002-b', issue: 2, stage: 'needs-info' })
    const r = await env.queue.rows()
    expect(rows(r)).toEqual(['resume #1', 'hold #3', 'wait #2'])
    expect(r[0]!.note).toBe('author replied')
  })

  test('waiting, finished and orphaned jobs', async () => {
    const env = await makeEnv()
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2 })
    await seed(env, { id: '001-a', issue: 1, stage: 'needs-human', pr: 5 })
    await seed(env, { id: '002-b', issue: 2, stage: 'rejected' })
    await seed(env, { id: '003-c', issue: 3, stage: 'review', round: 1 })
    const r = await env.queue.rows()
    expect(r.map(x => [x.action, x.issue, x.note])).toEqual([
      ['wait', 1, 'merge PR #5, or give feedback'],
      ['skip', 2, 'rejected; delete .factory/jobs/002-b to retry'],
      ['skip', 3, 'issue is closed or no longer labeled factory']
    ])
  })

  test('a job whose PR was merged by hand moves to merged', async () => {
    const env = await makeEnv()
    env.github.addIssue({ number: 1 })
    await seed(env, { id: '001-a', issue: 1, stage: 'review', round: 1, pr: 5 })
    env.github.prStates.set(5, 'MERGED')
    expect(rows(await env.queue.rows())).toEqual(['skip #1'])
    expect((await env.store.load('001-a')).stage).toBe('merged')
  })
})

describe('create', () => {
  test('numbers the job, slugs the title, quotes the issue', async () => {
    const env = await makeEnv()
    await seed(env, { id: '004-old', issue: 9, stage: 'merged' })
    env.github.addIssue({ number: 12, title: 'Add Dark-mode toggle to the settings page!' })
    const job = await env.queue.create(12)
    expect(job).toMatchObject({
      id: '005-add-dark-mode-toggle',
      issue: 12,
      branch: 'factory/005-add-dark-mode-toggle',
      stage: 'intake',
      round: 0,
      roundLimit: 3,
      issueUrl: 'https://github.com/o/r/issues/12',
      started: '2026-11-20T12:00:00Z'
    })
    expect(job.worktree).toBe(`${env.paths.worktrees}/005-add-dark-mode-toggle`)
    expect(await env.store.read(job.id, 'issue.md')).toContain('# Issue #12: Add Dark-mode toggle to the settings page!')
  })

  test('refuses duplicates, closed or unlabeled issues, and a full factory', async () => {
    const env = await makeEnv({ concurrency: 1 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2, state: 'CLOSED' })
    env.github.addIssue({ number: 3, labels: ['bug'] })
    env.github.addIssue({ number: 4 })
    await expect(env.queue.create(2)).rejects.toThrow('issue #2 is closed')
    await expect(env.queue.create(3)).rejects.toThrow('issue #3 isn\'t labeled factory')
    await env.queue.create(1)
    await expect(env.queue.create(1)).rejects.toThrow('issue #1 already has job 001-issue-1 (intake)')
    await expect(env.queue.create(4)).rejects.toThrow('concurrency 1 reached; running: 001-issue-1')
  })
})
