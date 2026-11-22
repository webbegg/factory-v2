import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec'
import { Refused } from './machine'
import type { Ports } from './ports'
import type { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, GateVerdict } from './types'

const TAIL = 80

/** Shell-style glob where `*` also crosses `/` (so `.factory/*` covers subfolders). */
export function globToRegExp(glob: string): RegExp {
  const src = [...glob].map((ch) => {
    if (ch === '*') return '.*'
    if (ch === '?') return '.'
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return new RegExp(`^${src}$`)
}

/** The factory's own checks, config and prompts: no branch may touch them, whatever the config says. */
export const ALWAYS_PROTECTED = ['.factory/*']

const CHECKS = '.factory/checks.sh'

export interface GateResult {
  verdict: GateVerdict
  code: number
  seconds: number
  commit: string
  protectedChanges: string[]
  /** one-line summary for logs and the UI */
  line: string
}

export interface ChecksRun {
  code: number
  output: string
  seconds: number
}

export interface GateOptions {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  ports: Ports
}

/**
 * Does the job's branch pass the repo's checks? Runs the base branch's
 * `.factory/checks.sh` inside the worktree, so neither a branch nor an agent
 * can edit the checks it is judged by, and fails any branch that touches a
 * protected file. Writes round-N/checks.md (or merge-checks.md) and its log.
 */
export class Gate {
  constructor(private o: GateOptions) {}

  /**
   * Runs `.factory/checks.sh` as committed on origin/<base>. An agent with a
   * shell can edit the main checkout's copy; it can't change what was merged.
   */
  async runChecks(worktree: string, signal?: AbortSignal): Promise<ChecksRun> {
    const start = performance.now()
    const ref = `origin/${this.o.config.baseBranch}`
    const script = await this.o.ports.git.show(this.o.paths.repo, ref, CHECKS)
    if (script === null) {
      return { code: 127, output: `${CHECKS} isn't committed on ${ref}: commit and push it first.\n`, seconds: 0 }
    }
    const dir = await mkdtemp(join(tmpdir(), 'factory-checks-'))
    try {
      const file = join(dir, 'checks.sh')
      await writeFile(file, script)
      const res = await run('bash', [file], {
        cwd: worktree, env: { CI: '1' }, scrub: true, signal, timeoutMs: this.o.config.limits.checksMinutes * 60_000
      })
      return { code: res.code, output: res.stdout + res.stderr, seconds: Math.round((performance.now() - start) / 1000) }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** Protected files the branch added, changed or deleted; an added CI workflow or prompt is as dangerous as an edit. */
  async protectedChanges(worktree: string): Promise<string[]> {
    const patterns = [...ALWAYS_PROTECTED, ...this.o.config.protectedPaths].map(globToRegExp)
    const changed = await this.o.ports.git.changedFiles(worktree, `origin/${this.o.config.baseBranch}`)
    return changed
      .filter(f => patterns.some(p => p.test(f.path)))
      .map(f => `${f.status} ${f.path}`)
  }

  async run(id: string, opts: { merge?: boolean, signal?: AbortSignal } = {}): Promise<GateResult> {
    const { store, ports, config } = this.o
    const job = await store.load(id)
    if (job.round < 1) throw new Refused(`${id} hasn't started a build round`)
    const commit = await ports.git.head(job.worktree)
    const protectedChanges = await this.protectedChanges(job.worktree)
    const checks = await this.runChecks(job.worktree, opts.signal)
    const verdict: GateVerdict = checks.code === 0 && !protectedChanges.length ? 'PASS' : 'FAIL'
    const name = opts.merge ? 'merge-checks' : 'checks'
    const rd = `round-${job.round}`
    const tail = checks.output.trimEnd().split('\n').slice(-TAIL).join('\n')
    const ran = checks.code === 0 ? 'passed' : `failed with exit ${checks.code}`
    const summary = [
      `checks.sh ${ran} in ${checks.seconds}s`,
      `Protected paths: ${protectedChanges.length ? `changed: ${protectedChanges.join(', ')}` : 'none changed'}`,
      `Commit ${commit.slice(0, 7)}${opts.merge ? `, synced with the latest ${config.baseBranch} before merging` : ''}`
    ]
    await store.write(id, `${rd}/${name}.log`, checks.output)
    await store.write(id, `${rd}/${name}.md`, [
      `GATE: ${verdict}`,
      `COMMIT: ${commit}`,
      '',
      '## Summary',
      ...summary.map(s => `- ${s}`),
      '',
      '## Protected paths',
      protectedChanges.length ? protectedChanges.map(p => `- ${p}`).join('\n') : 'None changed.',
      '',
      '## checks.sh',
      `Exit ${checks.code} in ${checks.seconds}s. Last ${TAIL} lines of ${name}.log:`,
      '',
      '```',
      tail,
      '```',
      ''
    ].join('\n'))
    const line = `GATE: ${verdict} (${id} round ${job.round}, checks.sh exit ${checks.code} in ${checks.seconds}s`
      + `${protectedChanges.length ? `, protected paths changed: ${protectedChanges.join(', ')}` : ''})`
    return { verdict, code: checks.code, seconds: checks.seconds, commit, protectedChanges, line }
  }
}
