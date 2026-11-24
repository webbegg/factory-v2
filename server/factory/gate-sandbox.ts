import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

/** what a gate run may reach: the repo's git dir (denied) and the hosts beyond the npm registry */
export interface GateSandbox {
  gitDir: string
  domains: string[]
}

const REGISTRY_HOSTS = ['registry.npmjs.org']
/** never readable by branch code; the model and GitHub env vars are scrubbed before it starts */
export const SECRET_FILES = ['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.npmrc', '~/.docker/config.json', '~/.config/gh', '~/.git-credentials']

/**
 * Where a worktree's checks keep their package caches between rounds: one
 * folder per worktree, outside the repo, so a branch can't fill or poison the
 * user's own caches, or another job's.
 */
export function gateCacheDir(worktree: string): string {
  return join(tmpdir(), 'factory-gate-cache', createHash('sha256').update(worktree).digest('hex').slice(0, 12))
}

/**
 * The sandbox for one checks.sh run: writes to the worktree, the run's temp
 * folder and the worktree's cache only, never the repo's git dir nor the
 * worktree's .git file; network to the npm registry and `domains` only, plus
 * local ports for dev servers and tests; no secret files.
 */
export function gateSandboxConfig(worktree: string, runDir: string, s: GateSandbox): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [...REGISTRY_HOSTS, ...s.domains], deniedDomains: [], strictAllowlist: true, allowLocalBinding: true },
    filesystem: {
      denyRead: SECRET_FILES,
      allowWrite: [worktree, runDir, gateCacheDir(worktree)],
      denyWrite: [join(worktree, '.git'), s.gitDir]
    }
  }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

let ready: Promise<void> | null = null
let hosts = ''

/** The runtime's proxies live in this process; started once, and their allow list kept to the config's. */
async function start(config: SandboxRuntimeConfig) {
  const want = JSON.stringify(config.network.allowedDomains)
  if (!ready) {
    hosts = want
    ready = SandboxManager.initialize(config).catch((err: unknown) => {
      ready = null
      throw err
    })
  }
  await ready
  if (hosts !== want) {
    SandboxManager.updateConfig(config)
    hosts = want
  }
}

/**
 * The command, arguments and extra environment that run `bash <script>` in
 * `worktree` under the gate sandbox. The runtime's own variables (its proxies)
 * are returned on their own, so the caller can lay them over a scrubbed
 * environment rather than this process's.
 */
export async function wrapChecks(script: string, worktree: string, runDir: string, s: GateSandbox): Promise<{ cmd: string, args: string[], env: Record<string, string> }> {
  const config = gateSandboxConfig(worktree, runDir, s)
  await start(config)
  const tmp = join(runDir, 'tmp')
  const cache = gateCacheDir(worktree)
  await mkdir(tmp, { recursive: true })
  await mkdir(cache, { recursive: true, mode: 0o700 })
  // the runtime points TMPDIR at a folder every sandboxed command shares; each run gets its own
  const command = `export TMPDIR=${quote(tmp)}; exec bash ${quote(script)}`
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command, undefined, config, undefined, worktree)
  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && process.env[k] !== v) extra[k] = v
  Object.assign(extra, {
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
    npm_config_cache: join(cache, 'npm'),
    XDG_CACHE_HOME: join(cache, 'xdg')
  })
  return { cmd: argv[0]!, args: argv.slice(1), env: extra }
}
