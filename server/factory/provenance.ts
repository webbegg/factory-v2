import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './exec'

/** What the running factory is, recorded in every job it creates. */
export interface BuildInfo {
  factoryVersion: string
  /** the package's git HEAD, null when it isn't a git checkout */
  factorySha: string | null
  /** trimmed `claude --version`, null when it fails or claude is missing */
  claudeVersion: string | null
}

/** The sha `ui()` read when it took the board's snapshot; empty means it couldn't read one. */
export const BUILD_SHA_ENV = 'FACTORY_BUILD_SHA'

/** Short enough for a key, long enough that other content never matches. */
export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * The factory package root: the nearest package.json named factory-v2 above
 * this module, which is a source file, the dev server's bundle or a board
 * snapshot inside the package.
 */
function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'factory-v2') return dir
    const up = dirname(dir)
    if (up === dir) throw new Error('the factory package.json was not found')
    dir = up
  }
}

// The factory's own package.json, never the project's in repo / cwd
export function factoryVersion(): string {
  return (JSON.parse(readFileSync(join(packageDir(), 'package.json'), 'utf8')) as { version: string }).version
}

export async function factorySha(): Promise<string | null> {
  const res = await run('git', ['rev-parse', 'HEAD'], { cwd: packageDir() })
  return res.code === 0 ? res.stdout.trim() : null
}

async function claudeVersion(): Promise<string | null> {
  const res = await run('claude', ['--version'], { cwd: packageDir() })
  return res.code === 0 ? res.stdout.trim() || null : null
}

let resolved: Promise<BuildInfo> | null = null

/** Read once per process: a later commit to the package must not change what this process records. */
export function buildInfo(): Promise<BuildInfo> {
  resolved ??= (async () => {
    const fixed = process.env[BUILD_SHA_ENV]
    return {
      factoryVersion: factoryVersion(),
      factorySha: fixed === undefined ? await factorySha() : fixed || null,
      claudeVersion: await claudeVersion()
    }
  })()
  return resolved
}
