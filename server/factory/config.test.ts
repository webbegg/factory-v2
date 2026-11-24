import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultConfig, loadConfig, saveConfig, validateConfigUpdate } from './config'
import type { ConfigUpdate } from './config'
import { makeEnv } from './testing'

function good(): ConfigUpdate {
  const { concurrency, maxRounds, baseBranch, mergeMethod, models, routing, protectedPaths } = defaultConfig()
  return { concurrency, maxRounds, baseBranch, mergeMethod, models, routing, protectedPaths }
}

describe('validateConfigUpdate', () => {
  test('accepts a good config', () => {
    const update = { ...good(), concurrency: 2, baseBranch: 'release/v1.2', mergeMethod: 'squash' as const, protectedPaths: [] }
    expect(validateConfigUpdate(update)).toEqual(update)
  })

  test('rejects an unknown key, including the keys the page does not edit', () => {
    expect(() => validateConfigUpdate({ ...good(), foo: 1 })).toThrow('unknown key "foo"')
    expect(() => validateConfigUpdate({ ...good(), ports: { base: 1, step: 1 } })).toThrow('unknown key "ports"')
    expect(() => validateConfigUpdate({ ...good(), models: { ...good().models, extra: 'x' } })).toThrow('unknown key "models.extra"')
  })

  test('rejects a wrong type or a missing key', () => {
    expect(() => validateConfigUpdate('nope')).toThrow('config must be an object')
    expect(() => validateConfigUpdate({ ...good(), maxRounds: '3' })).toThrow('maxRounds must be a number')
    expect(() => validateConfigUpdate({ ...good(), models: { ...good().models, spec: '' } })).toThrow('models.spec must be a non-empty string')
    expect(() => validateConfigUpdate({ ...good(), protectedPaths: 'a' })).toThrow('protectedPaths must be an array')
    expect(() => validateConfigUpdate({ ...good(), protectedPaths: [' a'] })).toThrow('protectedPaths[0] must be a non-empty, trimmed string')
    const { routing: _, ...missing } = good()
    expect(() => validateConfigUpdate(missing)).toThrow('routing is required')
  })

  test('rejects out-of-range numbers and fractions', () => {
    expect(() => validateConfigUpdate({ ...good(), concurrency: 9 })).toThrow('concurrency must be an integer from 1 to 8')
    expect(() => validateConfigUpdate({ ...good(), concurrency: 1.5 })).toThrow('concurrency must be an integer from 1 to 8')
    expect(() => validateConfigUpdate({ ...good(), maxRounds: 0 })).toThrow('maxRounds must be an integer from 1 to 10')
  })

  test('rejects unsafe branch names, merge methods and routing shapes', () => {
    for (const branch of ['', '-x', '/x', 'a..b', 'a b', 'a;b']) {
      expect(() => validateConfigUpdate({ ...good(), baseBranch: branch })).toThrow('baseBranch')
    }
    expect(() => validateConfigUpdate({ ...good(), mergeMethod: 'ff' })).toThrow('mergeMethod must be one of merge, squash, rebase')
    expect(() => validateConfigUpdate({ ...good(), routing: { low: {}, medium: {} } })).toThrow('routing.high is required')
    expect(() => validateConfigUpdate({ ...good(), routing: { ...good().routing, low: { 'a b': 'haiku' } } })).toThrow('routing.low has a bad lens name "a b"')
    expect(() => validateConfigUpdate({ ...good(), routing: { ...good().routing, low: { code: 'big model' } } })).toThrow('routing.low.code must be a non-empty string with no whitespace')
  })
})

describe('ci config', () => {
  async function load(raw: unknown) {
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    await writeFile(join(env.paths.factory, 'config.json'), JSON.stringify(raw))
    return (await loadConfig(env.paths)).ci
  }

  test('a missing or non-object ci gives the defaults', async () => {
    expect(defaultConfig().ci).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
    expect(await load({})).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
    expect(await load({ ci: 'yes' })).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
    expect(await load({ ci: [1] })).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
  })

  test('merges per key', async () => {
    expect(await load({ ci: { minutes: 10 } })).toEqual({ wait: true, startMinutes: 2, minutes: 10 })
    expect(await load({ ci: { wait: false, startMinutes: 0.5 } })).toEqual({ wait: false, startMinutes: 0.5, minutes: 30 })
  })

  test('each invalid value falls back to its own default', async () => {
    expect(await load({ ci: { wait: 'yes', minutes: 0, startMinutes: -1 } })).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
    expect(await load({ ci: { wait: false, minutes: 'x', startMinutes: 5 } })).toEqual({ wait: false, startMinutes: 5, minutes: 30 })
    expect(await load({ ci: { minutes: true, startMinutes: null } })).toEqual({ wait: true, startMinutes: 2, minutes: 30 })
  })
})

describe('sandbox config (#49)', () => {
  async function load(raw: unknown) {
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    await writeFile(join(env.paths.factory, 'config.json'), JSON.stringify(raw))
    return (await loadConfig(env.paths)).sandbox
  }

  const OFF = { enabled: false, domains: [], maxFileMB: 10 }
  const ON = { ...OFF, enabled: true }

  test('off by default, and when the block is missing or not an object', async () => {
    expect(defaultConfig().sandbox).toEqual(OFF)
    expect(await load({})).toEqual(OFF)
    expect(await load({ sandbox: true })).toEqual(OFF)
  })

  test('on, with extra domains for the builder and the gate', async () => {
    expect(await load({ sandbox: { enabled: true } })).toEqual(ON)
    expect(await load({ sandbox: { enabled: true, domains: ['pypi.org', '*.pythonhosted.org'] } }))
      .toEqual({ ...ON, domains: ['pypi.org', '*.pythonhosted.org'] })
  })

  test('only a boolean true turns it on, and a bad domain is dropped', async () => {
    expect(await load({ sandbox: { enabled: 'yes' } })).toEqual(OFF)
    expect(await load({ sandbox: { enabled: true, domains: ['ok.dev', '', 'a b', 42, '*', 'x/y'] } }))
      .toEqual({ ...ON, domains: ['ok.dev'] })
    expect(await load({ sandbox: { enabled: true, domains: 'pypi.org' } })).toEqual(ON)
  })

  test('maxFileMB caps a file the factory commits for a sandboxed builder; a bad value keeps 10 (#68)', async () => {
    expect(await load({ sandbox: { enabled: true, maxFileMB: 50 } })).toEqual({ ...ON, maxFileMB: 50 })
    expect(await load({ sandbox: { enabled: true, maxFileMB: 0.5 } })).toEqual({ ...ON, maxFileMB: 0.5 })
    for (const bad of [0, -1, '50', null, Infinity]) expect(await load({ sandbox: { enabled: true, maxFileMB: bad } })).toEqual(ON)
  })
})

describe('defaultConfig', () => {
  test('the UI reviewer defaults to sonnet; a config that sets it keeps its value', async () => {
    expect(defaultConfig().surfaceReviewers.ui!.ui).toBe('sonnet')
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    await writeFile(join(env.paths.factory, 'config.json'), JSON.stringify({ surfaceReviewers: { ui: { ux: 'sonnet', ui: 'haiku' } } }))
    expect((await loadConfig(env.paths)).surfaceReviewers.ui!.ui).toBe('haiku')
  })
})

describe('saveConfig', () => {
  async function seeded() {
    const env = await makeEnv()
    await mkdir(env.paths.factory, { recursive: true })
    const file = join(env.paths.factory, 'config.json')
    const raw = {
      concurrency: 1,
      baseBranch: 'master',
      labels: { queue: 'q', needsInfo: 'qi', needsHuman: 'qh' },
      surfaceReviewers: { ui: { ux: 'sonnet' } },
      ports: { base: 6000, step: 5 },
      custom: true
    }
    await writeFile(file, JSON.stringify(raw))
    return { paths: env.paths, file, raw }
  }

  test('overlays the update, keeps the other keys and writes a pretty file', async () => {
    const { paths, file, raw } = await seeded()
    const config = await saveConfig(paths, { ...good(), concurrency: 2, baseBranch: 'master' })
    const text = await readFile(file, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    const saved = JSON.parse(text) as Record<string, unknown>
    expect(text).toBe(JSON.stringify(saved, null, 2) + '\n')
    expect(saved.concurrency).toBe(2)
    expect(saved.labels).toEqual(raw.labels)
    expect(saved.surfaceReviewers).toEqual(raw.surfaceReviewers)
    expect(saved.ports).toEqual(raw.ports)
    expect(saved.custom).toBe(true)
    expect(config).toMatchObject({ concurrency: 2, ports: raw.ports, labels: raw.labels })
    expect(config.protectedPaths).toEqual(good().protectedPaths)
  })

  test('a partial limits block keeps the other limits\' defaults', async () => {
    const { paths, file, raw } = await seeded()
    await writeFile(file, JSON.stringify({ ...raw, limits: { checksMinutes: 5 } }))
    expect((await loadConfig(paths)).limits).toEqual({ ...defaultConfig().limits, checksMinutes: 5 })
  })

  test('limits that aren\'t positive numbers fall back to the defaults (review R3-002)', async () => {
    const { paths, file, raw } = await seeded()
    await writeFile(file, JSON.stringify({ ...raw, limits: { checksMinutes: 0, agentTurns: -1, agentBudgetUsd: 'lots' } }))
    expect((await loadConfig(paths)).limits).toEqual(defaultConfig().limits)
  })

  test('an invalid update leaves the file byte-for-byte unchanged', async () => {
    const { paths, file } = await seeded()
    const before = await readFile(file, 'utf8')
    await expect(saveConfig(paths, { ...good(), concurrency: 9 })).rejects.toThrow('concurrency')
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
