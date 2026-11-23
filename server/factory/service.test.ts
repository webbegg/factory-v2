import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acquireLock, fixtureDir, fixtureMode, fixtureRefusal, fixtureState, isLocalHost, jobFiles, openFixtures, readJobFile, requestRefusal } from './service'
import { makeEnv, newJob, seed } from './testing'
import { STAGES } from './types'

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

  test('screenshot folders are never listed, a review-named file inside one included', async () => {
    const env = await makeEnv()
    await seed(env, {}, {
      'round-1/review-ui.md': 'VERDICT: CHANGES\n',
      'round-1/screenshots-ui/review-ui.md': 'VERDICT: PASS\n',
      'round-1/screenshots-ui/desktop.png': 'png',
      'round-1/screenshots-ux/review-ux.md': 'VERDICT: PASS\n'
    })
    await mkdir(join(env.store.dir('001-add-a-thing'), 'round-1/screenshots-x.md'))
    expect((await jobFiles(env.store, '001-add-a-thing')).map(f => f.path)).toEqual(['round-1/review-ui.md'])
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

describe('fixture mode', () => {
  const FIXTURES = resolve(import.meta.dir, '../../fixtures/board')

  test('only FACTORY_FIXTURES=1 switches it on, and it serves fixtures/board under the cwd', () => {
    expect(fixtureMode({ FACTORY_FIXTURES: '1' })).toBe(true)
    for (const v of [undefined, '', '0', 'true']) expect(fixtureMode({ FACTORY_FIXTURES: v })).toBe(false)
    expect(fixtureDir('/r')).toBe('/r/fixtures/board')
  })

  test('opens the fixtures without the lock while a live process holds a real project\'s', async () => {
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    const lock = join(env.paths.factory, 'orchestrator.lock')
    await writeFile(lock, `${process.pid}\n`)
    const board = await openFixtures(FIXTURES)
    expect(board.paths.repo).toBe(FIXTURES)
    expect(existsSync(join(FIXTURES, '.factory/orchestrator.lock'))).toBe(false)
    expect(await readFile(lock, 'utf8')).toBe(`${process.pid}\n`)
    const state = await fixtureState(board)
    expect(state).toMatchObject({ project: FIXTURES, queued: [], draining: false, running: board.fixtures.running })
    expect(state.jobs.length).toBeGreaterThan(0)
    expect(existsSync(join(FIXTURES, '.factory/orchestrator.lock'))).toBe(false)
  })

  test('the committed fixtures cover the board\'s common states', async () => {
    const { store, fixtures, config } = await openFixtures(FIXTURES)
    const jobs = await store.list()
    const keys = Object.keys(newJob(await makeEnv())).sort()
    for (const job of jobs) {
      expect(Object.keys(job).sort()).toEqual(keys)
      expect(STAGES).toContain(job.stage)
      expect(job.id).toBe(job.id.replace(/[^\w.-]/g, ''))
    }
    expect(config.baseBranch).toBeString()
    expect(new Set(jobs.map(j => j.stage)).size).toBeGreaterThanOrEqual(3)
    expect(jobs.filter(j => fixtures.running.includes(j.id))).not.toHaveLength(0)
    expect(fixtures.running.every(id => jobs.some(j => j.id === id))).toBe(true)
    expect(jobs.some(j => j.stage === 'needs-human' || j.stage === 'needs-info')).toBe(true)
    expect(jobs.some(j => j.stage === 'merged')).toBe(true)
    const multi = []
    for (const j of jobs) {
      const files = (await jobFiles(store, j.id)).map(f => `${f.path} ${f.first}`)
      if (j.round >= 2 && files.includes('round-1/review-ui.md VERDICT: CHANGES') && files.some(f => f.startsWith('round-2/review-'))) multi.push(j.id)
    }
    expect(multi).not.toHaveLength(0)
    expect(Object.keys(fixtures.errors).every(id => jobs.some(j => j.id === id))).toBe(true)
    expect(fixtures.events.length).toBeGreaterThan(0)
    expect(fixtures.checks.every(c => typeof c.name === 'string' && typeof c.ok === 'boolean')).toBe(true)
  })

  test('refuses every API write and allows reads', () => {
    for (const path of ['/api/run', '/api/setup/init', '/api/jobs/001-x/retry', '/api/settings/config', '/api/uploads']) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        expect(fixtureRefusal({ method, path })).toEqual({ status: 403, message: 'fixture mode is read-only' })
      }
    }
    for (const method of ['GET', 'HEAD']) expect(fixtureRefusal({ method, path: '/api/state' })).toBeNull()
    expect(fixtureRefusal({ method: 'POST', path: '/_nuxt/x' })).toBeNull()
  })
})

describe('requestRefusal', () => {
  const req = (over: Partial<Parameters<typeof requestRefusal>[0]> = {}) => requestRefusal({
    host: 'localhost:4400', method: 'POST', path: '/api/run', contentType: 'application/json', ...over
  })

  test('the board\'s own requests pass', () => {
    expect(req({ origin: 'http://localhost:4400', fetchSite: 'same-origin' })).toBeNull()
    expect(req({ method: 'GET', path: '/api/state', fetchSite: 'same-origin' })).toBeNull()
    // a navigation to a page from elsewhere (a link on GitHub) is fine; only the API is guarded
    expect(req({ method: 'GET', path: '/', fetchSite: 'cross-site' })).toBeNull()
    // curl and the CLI send neither header
    expect(req({ method: 'GET', path: '/api/queue' })).toBeNull()
  })

  test('foreign hosts, origins and cross-site API calls are refused', () => {
    expect(req({ host: 'evil.com' })).toMatchObject({ status: 403 })
    expect(req({ origin: 'http://localhost:5110' })).toMatchObject({ status: 403 })
    expect(req({ origin: 'https://evil.com' })).toMatchObject({ status: 403 })
    expect(req({ origin: 'null' })).toMatchObject({ status: 403 })
    expect(req({ method: 'GET', path: '/api/queue', fetchSite: 'cross-site' })).toMatchObject({ status: 403 })
    // another localhost port (a job's dev server) is same-site, not same-origin
    expect(req({ method: 'GET', path: '/api/events', fetchSite: 'same-site' })).toMatchObject({ status: 403 })
  })

  test('API writes must be JSON', () => {
    expect(req({ contentType: 'application/x-www-form-urlencoded' })).toMatchObject({ status: 415 })
    expect(req({ method: 'GET', contentType: undefined })).toBeNull()
  })
})

describe('isLocalHost', () => {
  test('only loopback Host headers', () => {
    for (const h of ['localhost:4400', '127.0.0.1:4400', '[::1]:4400', 'localhost']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['evil.com', 'localhost.evil.com:4400', '10.0.0.2:4400', undefined]) expect(isLocalHost(h)).toBe(false)
  })
})
