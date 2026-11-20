import { readFile } from 'node:fs/promises'
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
      ui: { ux: 'sonnet', ui: 'haiku' },
      security: { security: 'opus' }
    },
    protectedPaths: ['.factory/checks.sh', '.factory/config.json'],
    ports: { base: 5100, step: 10 }
  }
}

export function factoryPaths(repo: string): FactoryPaths {
  const factory = join(repo, '.factory')
  return { repo, factory, jobs: join(factory, 'jobs'), worktrees: join(repo, '.worktrees') }
}

/** Reads <repo>/.factory/config.json over the defaults (top-level keys only). */
export async function loadConfig(paths: FactoryPaths): Promise<FactoryConfig> {
  const text = await readFile(join(paths.factory, 'config.json'), 'utf8')
  return { ...defaultConfig(), ...JSON.parse(text) as Partial<FactoryConfig> }
}
