import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLock, isLocalHost, jobFiles, readJobFile } from './service'
import { makeEnv, seed } from './testing'

describe('job files', () => {
  test('lists markdown files in reading order with their first line', async () => {
    const env = await makeEnv()
    await seed(env, {}, {
      'round-1/review-code.md': 'VERDICT: PASS\n',
      'round-1/checks.md': 'GATE: PASS\n',
      'round-1/checks.log': 'log',
      'spec.md': '# Spec\n',
      'issue.md': '# Issue\n',
      'feedback-1.md': '# Feedback 1\n',
      'round-2/checks.md': 'GATE: FAIL\n'
    })
    const files = await jobFiles(env.store, '001-add-a-thing')
    expect(files.map(f => f.path)).toEqual([
      'issue.md', 'spec.md', 'feedback-1.md',
      'round-1/checks.md', 'round-1/review-code.md', 'round-2/checks.md'
    ])
    expect(files[3]).toEqual({ path: 'round-1/checks.md', first: 'GATE: PASS', tone: 'good' })
    expect(files[5]!.tone).toBe('stop')
  })

  test('reads only files inside the job folder', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'spec.md': '# Spec\n' })
    expect(await readJobFile(env.store, '001-add-a-thing', 'spec.md')).toBe('# Spec\n')
    expect(await readJobFile(env.store, '001-add-a-thing', 'round-1/checks.log')).toBeNull()
    await expect(readJobFile(env.store, '001-add-a-thing', '../../config.json')).rejects.toThrow('outside the job folder')
    await expect(readJobFile(env.store, '../x', 'spec.md')).rejects.toThrow('bad job id')
  })
})

describe('lock', () => {
  test('one orchestrator per project; a stale lock from a dead process is taken over', async () => {
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    const release = await acquireLock(env.paths)
    await expect(acquireLock(env.paths)).rejects.toThrow(`already running (pid ${process.pid})`)
    await release()
    await writeFile(join(env.paths.factory, 'orchestrator.lock'), '999999999\n')
    const again = await acquireLock(env.paths)
    await again()
  })
})

describe('isLocalHost', () => {
  test('only loopback Host headers', () => {
    for (const h of ['localhost:4400', '127.0.0.1:4400', '[::1]:4400', 'localhost']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['evil.com', 'localhost.evil.com:4400', '10.0.0.2:4400', undefined]) expect(isLocalHost(h)).toBe(false)
  })
})
