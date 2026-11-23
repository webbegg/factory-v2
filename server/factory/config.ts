import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FactoryConfig, FactoryPaths } from './types'

export function defaultConfig(): FactoryConfig {
  return {
    concurrency: 3,
    maxRounds: 3,
    baseBranch: 'main',
    mergeMethod: 'merge',
    labels: { queue: 'factory', needsInfo: 'factory:needs-info', needsHuman: 'factory:needs-human' },
    models: { intake: 'fable', spec: 'opus', builder: 'opus', approver: 'opus' },
    routing: {
      low: { code: 'haiku' },
      medium: { code: 'sonnet' },
      high: { code: 'sonnet' }
    },
    surfaceReviewers: {
      ui: { ux: 'sonnet', ui: 'sonnet' },
      security: { security: 'opus' }
    },
    protectedPaths: ['.factory/checks.sh', '.factory/config.json', '.github/*'],
    ports: { base: 5100, step: 10 },
    limits: { checksMinutes: 30, agentTurns: 300, agentBudgetUsd: 15 },
    ci: { wait: true, startMinutes: 2, minutes: 30 }
  }
}

export function factoryPaths(repo: string): FactoryPaths {
  const factory = join(repo, '.factory')
  return { repo, factory, jobs: join(factory, 'jobs'), worktrees: join(repo, '.worktrees') }
}

/** Reads <repo>/.factory/config.json over the defaults (top-level keys, and each limit and ci key on its own). */
export async function loadConfig(paths: FactoryPaths): Promise<FactoryConfig> {
  const text = await readFile(join(paths.factory, 'config.json'), 'utf8')
  return withDefaults(JSON.parse(text) as Partial<FactoryConfig>)
}

function withDefaults(raw: Partial<FactoryConfig>): FactoryConfig {
  const defaults = defaultConfig()
  // a zero, negative or non-numeric limit would switch the cap off or fail every job, so it falls back
  const positive = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const limits = Object.fromEntries(Object.entries(defaults.limits).map(([key, fallback]) => {
    return [key, positive((raw.limits as Record<string, unknown> | undefined)?.[key], fallback)]
  })) as FactoryConfig['limits']
  const ci: Record<string, unknown> = isObject(raw.ci) ? raw.ci : {}
  return {
    ...defaults,
    ...raw,
    limits,
    ci: {
      wait: typeof ci.wait === 'boolean' ? ci.wait : defaults.ci.wait,
      startMinutes: positive(ci.startMinutes, defaults.ci.startMinutes),
      minutes: positive(ci.minutes, defaults.ci.minutes)
    }
  }
}

/** The keys the Settings page edits; everything else in the file is left alone. */
export type ConfigUpdate = Pick<FactoryConfig, 'concurrency' | 'maxRounds' | 'baseBranch' | 'mergeMethod' | 'models' | 'routing' | 'protectedPaths'>

const EDITABLE = ['concurrency', 'maxRounds', 'baseBranch', 'mergeMethod', 'models', 'routing', 'protectedPaths'] as const
const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
const AGENT_MODELS = ['intake', 'spec', 'builder', 'approver'] as const
const RISKS = ['low', 'medium', 'high'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An object with exactly `keys`; `prefix` names nested fields in messages. */
function exactKeys(value: unknown, name: string, keys: readonly string[], prefix = ''): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${name} must be an object`)
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`unknown key "${prefix}${key}"`)
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${prefix}${key} is required`)
  }
  return value
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number') throw new Error(`${name} must be a number`)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

function model(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`)
  if (/\s/.test(value)) throw new Error(`${name} must be a non-empty string with no whitespace`)
  return value
}

/** Checks a Settings save by hand; throws an Error naming the bad field. */
export function validateConfigUpdate(input: unknown): ConfigUpdate {
  const o = exactKeys(input, 'config', EDITABLE)
  const concurrency = integer(o.concurrency, 'concurrency', 1, 8)
  const maxRounds = integer(o.maxRounds, 'maxRounds', 1, 10)

  const branch = o.baseBranch
  if (typeof branch !== 'string' || !branch) throw new Error('baseBranch must be a non-empty string')
  // It reaches git commands, so refuse anything that could read as an option or a range.
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-') || branch.startsWith('/') || branch.includes('..')) {
    throw new Error(`baseBranch "${branch}" is not a safe branch name`)
  }

  const mergeMethod = o.mergeMethod as ConfigUpdate['mergeMethod']
  if (!MERGE_METHODS.includes(mergeMethod)) throw new Error(`mergeMethod must be one of ${MERGE_METHODS.join(', ')}`)

  const m = exactKeys(o.models, 'models', AGENT_MODELS, 'models.')
  const models = Object.fromEntries(AGENT_MODELS.map(k => [k, model(m[k], `models.${k}`)])) as ConfigUpdate['models']

  const r = exactKeys(o.routing, 'routing', RISKS, 'routing.')
  const routing = Object.fromEntries(RISKS.map((risk) => {
    const lenses = r[risk]
    if (!isObject(lenses)) throw new Error(`routing.${risk} must be an object`)
    return [risk, Object.fromEntries(Object.entries(lenses).map(([lens, value]) => {
      if (!/^[\w-]+$/.test(lens)) throw new Error(`routing.${risk} has a bad lens name "${lens}"`)
      return [lens, model(value, `routing.${risk}.${lens}`)]
    }))]
  })) as ConfigUpdate['routing']

  if (!Array.isArray(o.protectedPaths)) throw new Error('protectedPaths must be an array')
  const protectedPaths = o.protectedPaths.map((p: unknown, i) => {
    if (typeof p !== 'string' || !p || p.trim() !== p) throw new Error(`protectedPaths[${i}] must be a non-empty, trimmed string`)
    return p
  })

  return { concurrency, maxRounds, baseBranch: branch, mergeMethod, models, routing, protectedPaths }
}

/**
 * Validates `input`, overlays it on the raw config.json so keys the page does
 * not edit stay as they were, and returns the config the engine should now use.
 */
export async function saveConfig(paths: FactoryPaths, input: unknown): Promise<FactoryConfig> {
  const update = validateConfigUpdate(input)
  const file = join(paths.factory, 'config.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<FactoryConfig>
  const next = { ...raw, ...update }
  await writeFile(file, JSON.stringify(next, null, 2) + '\n')
  return withDefaults(next)
}
