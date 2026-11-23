import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec'
import { Refused } from './machine'
import { header } from './markdown'
import type { Ports } from './ports'
import type { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, GateVerdict, Job } from './types'

export const TAIL = 80

/**
 * Runs a checks.sh script the way the gate does: from a temp file, in `cwd`,
 * with `CI=1`, no secrets in the environment and the `checksMinutes` timeout
 * (exit 124). The gate and doctor's base check share it so they can't drift.
 */
export async function runChecksScript(script: string, cwd: string, checksMinutes: number, signal?: AbortSignal): Promise<{ code: number, output: string, seconds: number }> {
  const start = performance.now()
  const dir = await mkdtemp(join(tmpdir(), 'factory-checks-'))
  try {
    const file = join(dir, 'checks.sh')
    await writeFile(file, script)
    const res = await run('bash', [file], { cwd, env: { CI: '1' }, scrub: true, signal, timeoutMs: checksMinutes * 60_000 })
    return { code: res.code, output: res.stdout + res.stderr, seconds: Math.round((performance.now() - start) / 1000) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

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
  /** the origin/<base> sha the checks ran against, null when it couldn't be read */
  base: string | null
  /** where a reused pass came from, when checks.sh didn't run */
  reused?: string
  /** one-line summary for logs and the UI */
  line: string
}

export interface ChecksRun {
  code: number
  output: string
  seconds: number
  /** origin/<base> sha read right after the fetch that came before reading checks.sh */
  base: string | null
}

/** The builder's latest stop check, kept in the orchestrator's memory where no agent can write it. */
export interface StopCheckRecord extends ChecksRun {
  round: number
  /** HEAD and cleanliness read before checks.sh ran, HEAD read after */
  before: string
  cleanBefore: boolean
  after: string
}

export interface GateRunOptions {
  merge?: boolean
  signal?: AbortSignal
  /** the builder's latest stop check, for the round gate */
  stopCheck?: StopCheckRecord
  /** merge gate only: the sync left HEAD unchanged, so the round's checks.md may stand in */
  headUnchanged?: boolean
}

const STOP_CHECK = 'the builder\'s stop check'

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
 * protected file. Writes round-N/checks.md (or merge-checks.md) and its log,
 * headed GATE, COMMIT and BASE (the origin/<base> sha the checks ran against).
 * checks.sh is skipped only when an earlier pass covers the same HEAD and
 * BASE on a clean worktree: the builder's stop check (kept in the
 * orchestrator's memory) or this round's checks.md. The reuse is written
 * down with its source, and protected paths are checked every time.
 */
export class Gate {
  constructor(private o: GateOptions) {}

  /**
   * Runs `.factory/checks.sh` as committed on origin/<base>. An agent with a
   * shell can edit the main checkout's copy; it can't change what was merged.
   */
  async runChecks(worktree: string, signal?: AbortSignal): Promise<ChecksRun> {
    const start = performance.now()
    const { baseBranch } = this.o.config
    // an agent can move the local origin/<base>; fetching first puts it back,
    // and the full ref name means a tag or branch called origin/<base> can't stand in
    await this.o.ports.git.fetch(this.o.paths.repo, baseBranch)
    const base = await this.baseSha()
    const script = await this.o.ports.git.show(this.o.paths.repo, `refs/remotes/origin/${baseBranch}`, CHECKS)
    if (script === null) {
      return { code: 127, output: `${CHECKS} isn't committed on origin/${baseBranch}: commit and push it first.\n`, seconds: 0, base }
    }
    const res = await runChecksScript(script, worktree, this.o.config.limits.checksMinutes, signal)
    return { code: res.code, output: res.output, seconds: Math.round((performance.now() - start) / 1000), base }
  }

  /** origin/<base> as last fetched; null when it can't be read, which never matches a reuse */
  private async baseSha(): Promise<string | null> {
    return this.o.ports.git.remoteHead(this.o.paths.repo, this.o.config.baseBranch).catch(() => null)
  }

  /**
   * An earlier pass that covers exactly this HEAD against exactly this
   * origin/<base>, on a clean worktree, or null. Reads afresh (fetch, base,
   * HEAD, clean) so nothing recorded earlier can vouch for a moved ref.
   */
  private async reusable(job: Job, commit: string, opts: GateRunOptions): Promise<{ source: string, run: ChecksRun } | null> {
    const { ports, paths, config, store } = this.o
    try {
      await ports.git.fetch(paths.repo, config.baseBranch)
      const base = await ports.git.remoteHead(paths.repo, config.baseBranch)
      if (await ports.git.head(job.worktree) !== commit) return null
      if (!base || base === 'unknown' || !await ports.git.isClean(job.worktree)) return null
      const s = opts.stopCheck
      if (!opts.merge && s && s.round === job.round && s.code === 0 && s.cleanBefore
        && s.before === commit && s.after === commit && s.base === base) {
        return { source: STOP_CHECK, run: s }
      }
      if (opts.merge && !opts.headUnchanged) return null
      const rel = `round-${job.round}/checks.md`
      const h = header(await store.read(job.id, rel) ?? '')
      if (h.GATE === 'PASS' && h.COMMIT === commit && h.BASE === base) {
        return { source: rel, run: { code: 0, output: '', seconds: 0, base } }
      }
    } catch {
      // any read that fails means the checks run
    }
    return null
  }

  /** Protected files the branch added, changed or deleted; an added CI workflow or prompt is as dangerous as an edit. */
  async protectedChanges(worktree: string): Promise<string[]> {
    const patterns = [...ALWAYS_PROTECTED, ...this.o.config.protectedPaths].map(globToRegExp)
    const changed = await this.o.ports.git.changedFiles(worktree, `origin/${this.o.config.baseBranch}`)
    return changed
      .filter(f => patterns.some(p => p.test(f.path)))
      .map(f => `${f.status} ${f.path}`)
  }

  async run(id: string, opts: GateRunOptions = {}): Promise<GateResult> {
    const { store, ports, config } = this.o
    const job = await store.load(id)
    if (job.round < 1) throw new Refused(`${id} hasn't started a build round`)
    const commit = await ports.git.head(job.worktree)
    // checked on every run: a reused pass never covers a protected-path change
    const protectedChanges = await this.protectedChanges(job.worktree)
    const reuse = await this.reusable(job, commit, opts)
    const checks = reuse?.run ?? await this.runChecks(job.worktree, opts.signal)
    const verdict: GateVerdict = checks.code === 0 && !protectedChanges.length ? 'PASS' : 'FAIL'
    const name = opts.merge ? 'merge-checks' : 'checks'
    const rd = `round-${job.round}`
    const tail = checks.output.trimEnd().split('\n').slice(-TAIL).join('\n')
    const ran = checks.code === 0 ? 'passed' : `failed with exit ${checks.code}`
    const note = reuse
      && `checks.sh not re-run: reused ${reuse.source} (passed on ${commit.slice(0, 7)} against ${config.baseBranch}@${checks.base!.slice(0, 7)})`
    const summary = [
      note || `checks.sh ${ran} in ${checks.seconds}s`,
      `Protected paths: ${protectedChanges.length ? `changed: ${protectedChanges.join(', ')}` : 'none changed'}`,
      `Commit ${commit.slice(0, 7)}${opts.merge ? `, synced with the latest ${config.baseBranch} before merging` : ''}`
    ]
    const ownLog = reuse?.source === `${rd}/${name}.md`
    if (reuse && reuse.source !== STOP_CHECK) {
      // a restart over its own checks.md keeps the log that pass wrote
      if (!ownLog) await store.write(id, `${rd}/${name}.log`, `reused ${reuse.source.replace(/\.md$/, '.log')}\n`)
    } else {
      await store.write(id, `${rd}/${name}.log`, checks.output)
    }
    const section = note && !checks.output
      ? [`${note}.`]
      : [`${note ? `${note}.` : `Exit ${checks.code} in ${checks.seconds}s.`} Last ${TAIL} lines of ${name}.log:`, '', '```', tail, '```']
    await store.write(id, `${rd}/${name}.md`, [
      `GATE: ${verdict}`,
      `COMMIT: ${commit}`,
      `BASE: ${checks.base ?? 'unknown'}`,
      '',
      '## Summary',
      ...summary.map(s => `- ${s}`),
      '',
      '## Protected paths',
      protectedChanges.length ? protectedChanges.map(p => `- ${p}`).join('\n') : 'None changed.',
      '',
      '## checks.sh',
      ...section,
      ''
    ].join('\n'))
    const line = `GATE: ${verdict} (${id} round ${job.round}, ${reuse ? `reused ${reuse.source}` : `checks.sh exit ${checks.code} in ${checks.seconds}s`}`
      + `${protectedChanges.length ? `, protected paths changed: ${protectedChanges.join(', ')}` : ''})`
    return { verdict, code: checks.code, seconds: checks.seconds, commit, protectedChanges, base: checks.base, reused: reuse?.source, line }
  }
}
