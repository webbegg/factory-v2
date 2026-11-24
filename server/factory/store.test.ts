import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEnv, newJob, seed } from './testing'

describe('JobStore', () => {
  test('save then load round-trips a job and leaves no temp file', async () => {
    const env = await makeEnv()
    const job = newJob(env)
    await env.store.save(job)
    expect(await env.store.load(job.id)).toEqual(job)
    expect(await readdir(env.store.dir(job.id))).toEqual(['job.json'])
  })

  test('load of a missing job throws', async () => {
    const env = await makeEnv()
    expect(env.store.load('nope')).rejects.toThrow('no job nope')
  })

  test('list returns jobs sorted by id and ignores folders without job.json', async () => {
    const env = await makeEnv()
    await env.store.save(newJob(env, { id: '002-b', issue: 2 }))
    await env.store.save(newJob(env, { id: '001-a', issue: 1 }))
    await env.store.write('003-c', 'issue.md', 'x')
    expect((await env.store.list()).map(j => j.id)).toEqual(['001-a', '002-b'])
  })

  test('archiveJob renames the folder to <id>.rejected-<n> with its files intact, and list skips it', async () => {
    const env = await makeEnv()
    const job = await seed(env, { id: '012-x', issue: 12, stage: 'rejected' }, { 'intake.md': 'DECISION: REJECT\n' })
    const json = await readFile(env.store.path('012-x', 'job.json'), 'utf8')
    expect(await env.store.archiveJob('012-x')).toBe('012-x.rejected-1')
    expect(existsSync(env.store.dir('012-x'))).toBe(false)
    const archive = join(env.paths.jobs, '012-x.rejected-1')
    expect((await readdir(archive)).sort()).toEqual(['intake.md', 'job.json'])
    expect(await readFile(join(archive, 'job.json'), 'utf8')).toBe(json)
    expect(await readFile(join(archive, 'intake.md'), 'utf8')).toBe('DECISION: REJECT\n')
    expect(await env.store.list()).toEqual([])

    await env.store.save(job)
    expect(await env.store.archiveJob('012-x')).toBe('012-x.rejected-2')
    expect((await readdir(env.paths.jobs)).sort()).toEqual(['012-x.rejected-1', '012-x.rejected-2'])
    expect(await readFile(join(archive, 'job.json'), 'utf8')).toBe(json)
    expect(await env.store.list()).toEqual([])
  })

  test('read returns null for missing files; write creates folders', async () => {
    const env = await makeEnv()
    await env.store.save(newJob(env))
    expect(await env.store.read('001-add-a-thing', 'spec.md')).toBeNull()
    await env.store.write('001-add-a-thing', 'round-1/checks.md', 'GATE: PASS\n')
    expect(await env.store.read('001-add-a-thing', 'round-1/checks.md')).toBe('GATE: PASS\n')
  })

  test('update serializes concurrent writers on the same job', async () => {
    const env = await makeEnv()
    await env.store.save(newJob(env))
    const bump = () => env.store.update('001-add-a-thing', async (job) => {
      const seen = job.costUsd
      await Bun.sleep(5)
      return { ...job, costUsd: seen + 1 }
    })
    await Promise.all([bump(), bump(), bump()])
    expect((await env.store.load('001-add-a-thing')).costUsd).toBe(3)
  })

  test('update does not save when the callback throws', async () => {
    const env = await makeEnv()
    await env.store.save(newJob(env))
    await expect(env.store.update('001-add-a-thing', () => {
      throw new Error('refused')
    })).rejects.toThrow('refused')
    expect((await env.store.load('001-add-a-thing')).stage).toBe('intake')
  })

  test('appendEvent adds one JSON line per event and swallows I/O errors', async () => {
    const env = await makeEnv()
    await env.store.save(newJob(env))
    await env.store.appendEvent('001-add-a-thing', { at: 't', type: 'merge', outcome: 'merged', commit: null, base: null })
    await env.store.appendEvent('001-add-a-thing', { at: 't', type: 'stage', from: 'merging', to: 'merged' })
    expect(await env.store.read('001-add-a-thing', 'events.jsonl')).toBe(
      '{"at":"t","type":"merge","outcome":"merged","commit":null,"base":null}\n{"at":"t","type":"stage","from":"merging","to":"merged"}\n')
    // no such job folder: the append fails, the caller doesn't
    expect(await env.store.appendEvent('999-missing', { at: 't', type: 'merge', outcome: 'merged', commit: null, base: null })).toBeUndefined()
  })
})
