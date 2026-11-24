import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MARKER } from './issue'
import { FAKE_BUILD, makeEnv, seed } from './testing'

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

  test('a paused job is skipped and still holds its slot', async () => {
    const env = await makeEnv({ concurrency: 2 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2 })
    env.github.addIssue({ number: 3 })
    await seed(env, { id: '001-a', issue: 2, stage: 'build', round: 1, paused: { by: 'operator', at: 'x', reason: 'cancel' } })
    const r = await env.queue.rows()
    expect(rows(r)).toEqual(['new #1', 'hold #3', 'skip #2'])
    expect(r[2]).toMatchObject({ job: '001-a', stage: 'build', note: 'paused: Resume on the board' })
    expect(await env.queue.freeSlots()).toBe(1)
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
      ['skip', 2, 're-labeled after rejection: Run again on the board'],
      ['skip', 3, 'issue is closed or no longer labeled factory']
    ])
  })

  test('after Run again archives a rejected job, its labeled issue is new and gets a job numbered above the archive', async () => {
    const env = await makeEnv()
    env.github.addIssue({ number: 26, title: 'Add a thing' })
    await seed(env, { id: '001-a', issue: 1, stage: 'merged' })
    const rejected = await seed(env, { id: '012-add-a-thing', issue: 26, stage: 'rejected' })
    await env.store.archiveJob(rejected.id)
    expect(await env.queue.rows()).toEqual([{ action: 'new', issue: 26, job: null, stage: null, note: 'Add a thing' }])
    const job = await env.queue.create(26)
    expect(job.id).toBe('013-add-a-thing')
    expect(job.branch).not.toBe(rejected.branch)
    expect(job.worktree).not.toBe(rejected.worktree)
    expect(env.store.dir(job.id)).not.toBe(join(env.paths.jobs, '012-add-a-thing.rejected-1'))
    expect(existsSync(join(env.paths.jobs, '012-add-a-thing.rejected-1', 'job.json'))).toBe(true)
  })

  test('a job whose PR was merged by hand moves to merged', async () => {
    const env = await makeEnv()
    env.github.addIssue({ number: 1 })
    await seed(env, { id: '001-a', issue: 1, stage: 'review', round: 1, pr: 5 })
    env.github.prStates.set(5, 'MERGED')
    await env.queue.sweepMerged(() => false)
    expect(rows(await env.queue.rows())).toEqual(['skip #1'])
    expect((await env.store.load('001-a')).stage).toBe('merged')
  })

  test('rows only read: listing the queue changes no job', async () => {
    const env = await makeEnv()
    env.github.addIssue({ number: 1 })
    await seed(env, { id: '001-a', issue: 1, stage: 'review', round: 1, pr: 5 })
    env.github.prStates.set(5, 'MERGED')
    await env.queue.rows()
    expect((await env.store.load('001-a')).stage).toBe('review')
    expect(env.git.calls).toEqual([])
  })

  test('the merged sweep leaves alone the jobs the caller is driving', async () => {
    const env = await makeEnv()
    await seed(env, { id: '001-a', issue: 1, stage: 'review', round: 1, pr: 5 })
    await seed(env, { id: '002-b', issue: 2, stage: 'build', round: 1, pr: 6 })
    env.github.prStates.set(5, 'MERGED')
    env.github.prStates.set(6, 'MERGED')
    await env.queue.sweepMerged(id => id === '001-a')
    expect((await env.store.list()).map(j => j.stage)).toEqual(['review', 'merged'])
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

  test('records provenance from the build and origin/<base>, never the working copy', async () => {
    const env = await makeEnv({ sandbox: { enabled: true, domains: [] } })
    env.git.remoteHeads.set('main', 'b'.repeat(40))
    env.git.committed.set('.factory/config.json', '{"concurrency":2}\n')
    await mkdir(env.paths.factory, { recursive: true })
    await writeFile(join(env.paths.factory, 'checks.sh'), 'bun test\n')
    env.github.addIssue({ number: 1 })
    const job = await env.queue.create(1)
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)
    const provenance = {
      factoryVersion: '0.0.0-test',
      factorySha: 'f'.repeat(40),
      claudeVersion: '2.1.300 (Claude Code)',
      baseSha: 'b'.repeat(40),
      configSha: sha256('{"concurrency":2}\n'),
      checksSha: null,
      sandbox: true
    }
    expect((await env.store.load(job.id)).provenance).toEqual(provenance)
    expect(env.git.calls).toContainEqual(['fetch', env.paths.repo, 'main'])
    expect(env.git.calls).toContainEqual(['show', env.paths.repo, 'refs/remotes/origin/main', '.factory/checks.sh'])

    env.git.committed.set('.factory/checks.sh', 'bun test\n')
    env.github.addIssue({ number: 2 })
    const next = await env.queue.create(2)
    expect((await env.store.load(next.id)).provenance?.checksSha).toBe(sha256('bun test\n'))
  })

  test('a missing claude or unreadable base still creates the job, with those fields null', async () => {
    const env = await makeEnv({}, { ...FAKE_BUILD, claudeVersion: null })
    env.git.fetch = () => Promise.reject(new Error('offline'))
    env.git.remoteHead = () => Promise.reject(new Error('no ref'))
    env.github.addIssue({ number: 1 })
    const job = await env.queue.create(1)
    expect((await env.store.load(job.id)).provenance).toMatchObject({ claudeVersion: null, baseSha: null, configSha: null, sandbox: false })
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

  test('admit refuses what create would, except a full factory, and creates nothing', async () => {
    const env = await makeEnv({ concurrency: 1 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2, state: 'CLOSED' })
    env.github.addIssue({ number: 3, labels: ['bug'] })
    env.github.addIssue({ number: 4 })
    await expect(env.queue.admit(2)).rejects.toThrow('issue #2 is closed')
    await expect(env.queue.admit(3)).rejects.toThrow('issue #3 isn\'t labeled factory')
    await env.queue.create(1)
    await expect(env.queue.admit(1)).rejects.toThrow('issue #1 already has job 001-issue-1 (intake)')
    await env.queue.admit(4)
    expect((await env.store.list()).map(j => j.issue)).toEqual([1])
  })

  test('free slots count only the jobs that hold one', async () => {
    const env = await makeEnv({ concurrency: 3 })
    expect(await env.queue.freeSlots()).toBe(3)
    await seed(env, { id: '001-a', issue: 1, stage: 'build', round: 1 })
    await seed(env, { id: '002-b', issue: 2, stage: 'needs-human' })
    await seed(env, { id: '003-c', issue: 3, stage: 'merged' })
    await seed(env, { id: '004-d', issue: 4, stage: 'intake' })
    expect(await env.queue.freeSlots()).toBe(1)
  })
})
