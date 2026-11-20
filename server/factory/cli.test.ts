import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { main, snapshotBuild, table } from './cli'
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

describe('version flag', () => {
  let log: ReturnType<typeof spyOn<Console, 'log'>> | undefined
  afterEach(() => log?.mockRestore())

  async function decoyRepo() {
    const repo = await mkdtemp(join(tmpdir(), 'factory-cli-'))
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'decoy', version: '9.9.9' }))
    return repo
  }

  for (const flag of ['--version', '-v']) {
    test(`${flag} prints the factory package version, not the project's`, async () => {
      const pkg = JSON.parse(await readFile(resolve(import.meta.dir, '../../package.json'), 'utf8')) as { version: string }
      const repo = await decoyRepo()
      log = spyOn(console, 'log').mockImplementation(() => {})
      await main([flag], repo)
      expect(log.mock.calls).toEqual([[pkg.version]])
    })
  }

  test('--help mentions --version', async () => {
    log = spyOn(console, 'log').mockImplementation(() => {})
    await main(['--help'], await decoyRepo())
    expect(String(log.mock.calls[0]?.[0])).toContain('--version')
  })
})

describe('snapshotBuild', () => {
  test('serves a private copy, so rebuilding the package does not break a running board', async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-build-'))
    const output = join(root, '.output')
    await mkdir(join(output, 'server/chunks'), { recursive: true })
    await writeFile(join(output, 'server/index.mjs'), 'entry')
    await writeFile(join(output, 'server/chunks/a.mjs'), 'chunk-a')
    const entry = await snapshotBuild(output, join(root, 'runtime'))
    expect(entry.startsWith(join(root, 'runtime'))).toBe(true)
    expect(await readFile(entry, 'utf8')).toBe('entry')
    // a rebuild replaces the package's chunks; the snapshot keeps the ones its entry imports
    await rm(output, { recursive: true })
    expect(await readFile(join(entry, '../chunks/a.mjs'), 'utf8')).toBe('chunk-a')
  })
})
