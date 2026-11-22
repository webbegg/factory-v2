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
 * Does the job's branch pass the repo's checks? Runs the main checkout's
 * `.factory/checks.sh` inside the worktree, so a branch can't edit the checks
 * it is judged by, and fails any branch that modifies or deletes a protected
 * file. Writes round-N/checks.md (or merge-checks.md) and its log.
 */
export class Gate {
  constructor(private o: GateOptions) {}

  get checksPath() {
    return join(this.o.paths.factory, 'checks.sh')
  }

  async runChecks(worktree: string): Promise<ChecksRun> {
    const start = performance.now()
    const res = await run('bash', [this.checksPath], { cwd: worktree, env: { CI: '1' } })
    return { code: res.code, output: res.stdout + res.stderr, seconds: Math.round((performance.now() - start) / 1000) }
  }

  /** Protected files the branch added, changed or deleted; an added CI workflow or prompt is as dangerous as an edit. */
  async protectedChanges(worktree: string): Promise<string[]> {
    const patterns = [...ALWAYS_PROTECTED, ...this.o.config.protectedPaths].map(globToRegExp)
    const changed = await this.o.ports.git.changedFiles(worktree, `origin/${this.o.config.baseBranch}`)
    return changed
      .filter(f => patterns.some(p => p.test(f.path)))
      .map(f => `${f.status} ${f.path}`)
  }

  async run(id: string, opts: { merge?: boolean } = {}): Promise<GateResult> {
    const { store, ports, config } = this.o
    const job = await store.load(id)
    if (job.round < 1) throw new Refused(`${id} hasn't started a build round`)
    const commit = await ports.git.head(job.worktree)
    const protectedChanges = await this.protectedChanges(job.worktree)
    const checks = await this.runChecks(job.worktree)
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
