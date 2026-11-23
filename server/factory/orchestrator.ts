import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { PROMPTS } from './agents/prompts'
import type { AgentName } from './agents/prompts'
import type { AgentEvent, AgentRunner, AgentTask } from './agents/runner'
import type { Gate, StopCheckRecord } from './gate'
import { redact } from './exec'
import { firstLine, section } from './markdown'
import { Refused } from './machine'
import type { Machine } from './machine'
import type { Merger } from './merge'
import type { Ports } from './ports'
import type { Queue } from './queue'
import { route } from './route'
import type { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, Job } from './types'

export interface OrchestratorOptions {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  ports: Ports
  machine: Machine
  queue: Queue
  gate: Gate
  merger: Merger
  runner: AgentRunner
}

export type FactoryEvent
  = | { type: 'job', job: Job }
    | { type: 'agent', jobId: string, agent: AgentName, event: AgentEvent }
    | { type: 'error', jobId: string, message: string }
    | { type: 'paused', jobId: string }
    | { type: 'archived', jobId: string, archived: string }
    | { type: 'log', message: string }
    | { type: 'queued', issues: number[] }
    | { type: 'idle' }

const TOOLS: Record<AgentName, string[]> = {
  'intake': ['Read', 'Grep', 'Glob', 'Write'],
  'spec-writer': ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  'builder': ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
  'reviewer-code': ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  'reviewer-security': ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  'reviewer-ux': ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  'reviewer-ui': ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  'approver': ['Read', 'Grep', 'Glob', 'Bash', 'Write']
}

const REPORT_FILE: Partial<Record<AgentName, string>> = {
  'intake': 'intake.md',
  'spec-writer': 'spec.md',
  'builder': 'build.md',
  'approver': 'decision.md'
}

const VERDICTS = ['VERDICT: PASS', 'VERDICT: CHANGES']

/** The ids `Queue.create` makes: a number, then a lowercase slug; no dots or slashes. */
const JOB_ID = /^\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** First lines a valid report may start with, per agent; the spec has no verdict line, so it has no fallback. */
const REPORT_HEAD: Partial<Record<AgentName, string[]>> = {
  'intake': ['DECISION: ACCEPT', 'DECISION: NEEDS-INFO', 'DECISION: REJECT'],
  'builder': ['STATUS: READY', 'STATUS: BLOCKED'],
  'approver': ['APPROVE', 'ESCALATE'],
  'reviewer-code': VERDICTS,
  'reviewer-security': VERDICTS,
  'reviewer-ux': VERDICTS,
  'reviewer-ui': VERDICTS
}

const isHead = (agent: AgentName, line: string) => REPORT_HEAD[agent]?.includes(line) ?? false

/** `a`, `b` or `c`, for an error an agent reads */
function either(values: string[]): string {
  const quoted = values.map(v => `\`${v}\``)
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`
}

/** A bad first line quoted back short enough for a toast or a terminal line. */
function quote(line: string): string {
  return `\`${line.length > 80 ? `${line.slice(0, 80)}…` : line}\``
}

/** A file's bytes (screenshots are binary) or a link's target, kept apart so no file can pass for a link. */
type Entry = { file: Buffer } | { link: string }

function same(a: Entry, b: Entry | undefined): boolean {
  if (!b) return false
  if ('link' in a) return 'link' in b && a.link === b.link
  return 'file' in b && a.file.equals(b.file)
}

/**
 * Every file and link under a job folder but job.json (guarded by field, see
 * TRUSTED) and in-flight temp files, by relative path. A link is recorded as
 * itself, never followed, so a planted link to a forged verdict shows up.
 */
async function snapshot(dir: string): Promise<Map<string, Entry>> {
  const files = new Map<string, Entry>()
  // walked by hand: a recursive readdir follows a planted directory link out of the folder
  const walk = async (sub: string) => {
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(rel)
      else if (entry.isSymbolicLink()) files.set(rel, { link: await readlink(join(dir, rel)).catch(() => '') })
      else if (entry.isFile() && rel !== 'job.json' && !entry.name.endsWith('.tmp')) files.set(rel, { file: await readFile(join(dir, rel)) })
    }
  }
  if (existsSync(dir)) await walk('')
  return files
}

/**
 * job.json fields only the factory sets; an agent changing them could reroute
 * or skip its own review, or hide or fake a stall that survives a restart.
 */
const TRUSTED = ['issue', 'branch', 'worktree', 'pr', 'prUrl', 'stage', 'round', 'roundLimit', 'roundReason', 'agents', 'error', 'move'] as const

function trusted(job: Job): string {
  return JSON.stringify(TRUSTED.map(k => job[k]))
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

/**
 * Deterministic driver of every job: takes work from the queue up to the
 * concurrency limit, runs the agent or script each stage needs, and moves the
 * job through the machine. All state is in files, so a new process resumes
 * where an old one stopped.
 */
export class Orchestrator extends EventEmitter {
  /** jobs with a driver running in this process */
  private active = new Map<string, { controller: AbortController, done: Promise<void> }>()
  private draining = false
  private ticking: Promise<void> = Promise.resolve()
  /** last failure per job, also kept in job.json (see `loadErrors`); the drain leaves these alone until `retry` */
  readonly errors = new Map<string, string>()
  /** jobs stopped by `cancel`; the drain leaves them alone until `start`, and like `errors` they are gone on restart */
  readonly paused = new Set<string>()
  /** running jobs `cancel` aborted, so their driver's end is a pause, not a failure */
  private cancelling = new Set<string>()
  /** issues run while every slot was busy, oldest first; like `errors`, gone on restart */
  private pending: number[] = []
  /** set by shutdown: nothing new starts, queued issues included */
  private stopped = false
  /**
   * The builder's latest stop check per job, for the gate to reuse. Memory
   * only, out of every agent's reach; a restart loses it and the gate just
   * runs checks.sh.
   */
  private stopChecks = new Map<string, StopCheckRecord>()

  constructor(private o: OrchestratorOptions) {
    super()
  }

  get isDraining() {
    return this.draining
  }

  runningJobs(): string[] {
    return [...this.active.keys()]
  }

  queuedIssues(): number[] {
    return [...this.pending]
  }

  private send(e: FactoryEvent) {
    this.emit('event', e)
  }

  /** Errors saved by an earlier process, so its stalled jobs stay stalled until retried. */
  async loadErrors(): Promise<void> {
    for (const job of await this.o.store.list()) {
      if (job.error) this.errors.set(job.id, job.error.message)
    }
  }

  // ---- Control ------------------------------------------------------------

  /** Work through every labeled issue, resuming jobs, until nothing is runnable. */
  async drain(): Promise<void> {
    this.draining = true
    await this.tick()
  }

  /** Start no new jobs; running ones continue to their next waiting point. */
  pause() {
    this.draining = false
  }

  /** Run (or resume) the job for one issue, or queue it until a slot is free. */
  async runIssue(issue: number): Promise<{ job: Job | null, queued: boolean }> {
    const existing = (await this.o.store.list()).find(j => j.issue === issue)
    if (existing) {
      this.start(existing.id)
      return { job: existing, queued: false }
    }
    await this.o.queue.admit(issue)
    if (!this.pending.includes(issue)) {
      this.pending.push(issue)
      this.sendQueued()
    }
    // starting goes through the serialized tick so earlier queued issues keep their turn
    await this.tick()
    const job = (await this.o.store.list()).find(j => j.issue === issue) ?? null
    return { job, queued: !job }
  }

  async feedback(id: string, text: string): Promise<Job> {
    const { job } = await this.o.machine.feedback(id, text, await this.o.ports.github.operator())
    this.start(id)
    return job
  }

  /** The operator's Merge on an escalated job: the merging step syncs, gates and merges it. */
  async approve(id: string): Promise<Job> {
    const { store, machine, ports } = this.o
    const current = await store.load(id)
    // merged by hand already: nothing was approved through the factory, so no APPROVE is written
    if (current.stage === 'needs-human' && current.pr && await ports.github.prState(current.pr) === 'MERGED') {
      const job = await machine.advance(id, 'merged')
      this.send({ type: 'job', job })
      return job
    }
    const job = await machine.approve(id, await ports.github.operator())
    this.start(id)
    return job
  }

  /** Paused or not, needs-human jobs whose PR someone merged on GitHub move to merged. */
  checkMerged(): Promise<void> {
    // on the tick's chain so it never overlaps a fill; the caller still sees a failure
    const run = this.ticking.then(() => this.o.queue.sweepMerged(id => this.active.has(id), 'needs-human'))
    this.ticking = run.catch((err) => {
      this.send({ type: 'log', message: `queue: ${(err as Error).message}` })
    })
    return run
  }

  async reject(id: string, text: string): Promise<Job> {
    const job = await this.o.machine.reject(id, text, await this.o.ports.github.operator())
    this.send({ type: 'job', job })
    return job
  }

  /** The operator answers intake's questions on the issue; the job goes back to intake. */
  async answer(id: string, text: string, reply: (issue: number, body: string) => Promise<void>): Promise<Job> {
    const next = await this.o.machine.answer(id, text, reply)
    this.start(id)
    return next
  }

  /**
   * Archives a rejected job's folder so its issue can get a fresh job on the
   * next drain or Run issue. Starts nothing and changes no labels: `labeled`
   * tells the caller whether the issue is open and queued already.
   */
  async runAgain(id: string): Promise<{ archived: string, labeled: boolean }> {
    const { store, ports, config } = this.o
    // the id comes from a URL and becomes a path, so only the shape `create` makes gets that far
    if (!JOB_ID.test(id)) throw new Refused(`${JSON.stringify(id)} isn't a job id`)
    const job = (await store.list()).find(j => j.id === id)
    if (!job) throw new Refused(`no job ${id}`)
    if (job.stage !== 'rejected') throw new Refused(`${id} is in ${job.stage}, not rejected`)
    if (this.active.has(id)) throw new Refused(`${id} is running`)
    const issue = await ports.github.fetchIssue(job.issue)
    const labeled = issue.state === 'OPEN' && issue.labels.includes(config.labels.queue)
    const archived = await store.archiveJob(id)
    this.errors.delete(id)
    this.paused.delete(id)
    this.send({ type: 'archived', jobId: id, archived })
    return { archived, labeled }
  }

  /** Restart a stalled job from its stage. */
  retry(id: string) {
    this.start(id)
  }

  /** Stops a running job and pauses it where it is, until it is started again. */
  cancel(id: string) {
    const a = this.active.get(id)
    if (!a) return
    this.cancelling.add(id)
    a.controller.abort()
  }

  /** Stops draining, aborts every running agent and gate, and waits for their drivers to stop. */
  async shutdown(): Promise<void> {
    this.pause()
    this.stopped = true
    for (const a of this.active.values()) a.controller.abort()
    await Promise.all([...this.active.values()].map(a => a.done))
  }

  /** Resolves once no job is running in this process. */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()].map(a => a.done))
    await this.ticking
    if (this.active.size) return this.idle()
  }

  // ---- Scheduling ---------------------------------------------------------

  private tick(): Promise<void> {
    this.ticking = this.ticking.then(() => this.fill()).catch((err) => {
      this.send({ type: 'log', message: `queue: ${(err as Error).message}` })
    })
    return this.ticking
  }

  private async fill() {
    if (this.stopped) return
    await this.startPending()
    if (!this.draining) return
    await this.o.queue.sweepMerged(id => this.active.has(id))
    for (const row of await this.o.queue.rows()) {
      if (row.action === 'new') {
        const job = await this.o.queue.create(row.issue)
        this.start(job.id)
      } else if (row.action === 'resume' && row.job && !this.active.has(row.job) && !this.errors.has(row.job) && !this.paused.has(row.job)) {
        if (row.stage === 'needs-info') await this.o.machine.advance(row.job, 'intake')
        this.start(row.job)
      }
    }
  }

  private sendQueued() {
    this.send({ type: 'queued', issues: this.queuedIssues() })
  }

  /** Queued issues get free slots before the drain, whether or not it runs. */
  private async startPending() {
    const { queue } = this.o
    while (this.pending.length && await queue.freeSlots() > 0) {
      const issue = this.pending[0]!
      try {
        await queue.admit(issue)
      } catch (err) {
        if (!(err instanceof Refused)) throw err
        this.pending.shift()
        this.sendQueued()
        this.send({ type: 'log', message: `queue: dropped issue #${issue}: ${err.message}` })
        continue
      }
      let job: Job
      try {
        job = await queue.create(issue)
      } catch (err) {
        // a slot taken outside the tick (feedback, retry) since we counted; wait for the next one
        if (err instanceof Refused) return
        throw err
      }
      this.pending.shift()
      this.sendQueued()
      this.start(job.id)
    }
  }

  private start(id: string) {
    if (this.active.has(id) || this.stopped) return
    const controller = new AbortController()
    this.errors.delete(id)
    this.paused.delete(id)
    // a cancelled driver may end by returning or by any error its abort surfaced as
    const pauseIfCancelled = () => {
      if (!this.cancelling.has(id)) return false
      this.paused.add(id)
      this.send({ type: 'paused', jobId: id })
      return true
    }
    const done = this.drive(id, controller.signal)
      .then(() => {
        pauseIfCancelled()
      })
      .catch(async (err: Error) => {
        if (pauseIfCancelled()) return
        const message = redact(err.message)
        this.errors.set(id, message)
        this.send({ type: 'error', jobId: id, message })
        // stopped by shutdown, the job resumes on the next start instead of stalling
        if (this.stopped && controller.signal.aborted) return
        await this.o.store.update(id, j => ({ ...j, error: { message, at: this.o.ports.now() } }))
          .catch((e: Error) => this.send({ type: 'log', message: `${id}: couldn't save its error: ${e.message}` }))
      })
      .finally(async () => {
        this.cancelling.delete(id)
        this.active.delete(id)
        // a job whose driver stopped has left build/gate as far as this record goes
        this.stopChecks.delete(id)
        await this.tick()
        if (!this.active.size) this.send({ type: 'idle' })
      })
    this.active.set(id, { controller, done })
  }

  private async drive(id: string, signal: AbortSignal) {
    if ((await this.o.store.load(id)).error) await this.o.store.update(id, j => ({ ...j, error: null }))
    while (!signal.aborted) {
      const job = await this.o.store.load(id)
      this.send({ type: 'job', job })
      if (!await this.step(job, signal)) return
    }
  }

  // ---- Stages -------------------------------------------------------------

  /** Runs the work of the job's stage and moves it on. False when it waits or is done. */
  private async step(job: Job, signal: AbortSignal): Promise<boolean> {
    const { machine, gate, store, config } = this.o
    switch (job.stage) {
      case 'intake': {
        await this.agent(job, 'intake', signal)
        const synced = await machine.sync(await store.load(job.id))
        const decision = synced.intake?.decision
        if (decision === 'ACCEPT') {
          await machine.recordAgents(job.id, route(synced.intake!, config))
          await machine.advance(job.id, 'spec')
        } else if (decision === 'NEEDS-INFO') {
          await machine.advance(job.id, 'needs-info')
        } else if (decision === 'REJECT') {
          await machine.advance(job.id, 'rejected')
        } else {
          throw new Refused(`intake.md has no valid DECISION line (got ${decision ?? 'nothing'})`)
        }
        return true
      }
      case 'spec':
        await this.agent(job, 'spec-writer', signal)
        await machine.advance(job.id, 'build')
        return true
      case 'build':
        return this.build(job, signal)
      case 'gate': {
        const stopCheck = this.stopChecks.get(job.id)
        this.stopChecks.delete(job.id)
        const result = await gate.run(job.id, { signal, stopCheck })
        await store.appendEvent(job.id, { at: this.o.ports.now(), type: 'gate', verdict: result.verdict, seconds: result.seconds, commit: result.commit })
        if (signal.aborted) throw new Error('gate cancelled')
        this.send({ type: 'log', message: result.line })
        if (result.verdict === 'PASS') await machine.advance(job.id, 'review')
        else await machine.advance(job.id, job.round >= job.roundLimit ? 'needs-human' : 'build')
        return true
      }
      case 'review':
        return this.review(job, signal)
      case 'approve': {
        // an earlier round's APPROVE must never stand in for this round's decision
        await store.archive(job.id, 'decision.md')
        await this.agent(job, 'approver', signal, `PR: #${job.pr}. Final round: ${job.round}.`)
        const line = firstLine(await store.read(job.id, 'decision.md') ?? '')
        if (line === 'APPROVE') await this.merge(job, signal)
        else await machine.advance(job.id, 'needs-human')
        return true
      }
      case 'merging':
        await this.merge(job, signal)
        return true
      default:
        return false
    }
  }

  private async merge(job: Job, signal: AbortSignal) {
    const { merger, store, ports } = this.o
    try {
      const merged = await merger.merge(job.id, signal)
      await store.appendEvent(job.id, { at: ports.now(), type: 'merge', outcome: merged.stage })
    } catch (err) {
      await store.appendEvent(job.id, { at: ports.now(), type: 'merge', outcome: 'error', error: redact((err as Error).message) })
      throw err
    }
  }

  private buildPurpose(job: Job): string {
    const prev = job.round - 1
    const reason = job.roundReason ?? 'spec'
    if (reason === 'gate') return `The gate failed: read round-${prev}/checks.md and checks.log, fix it, push, and update build.md.`
    if (reason === 'sync') {
      const base = `origin/${this.o.config.baseBranch}`
      return `The branch conflicts with ${base}: read round-${prev}/sync.md, merge ${base}, resolve the conflicts, push, and update build.md for round ${job.round}.`
    }
    if (reason === 'review') return `Round ${prev} reviews are in round-${prev}/. Address every VERDICT: CHANGES, push, and update build.md for round ${job.round}.`
    if (reason.startsWith('feedback:')) {
      return `The user gave feedback: read ${reason.slice('feedback:'.length)} and address it, push, and update build.md for round ${job.round}.`
    }
    return job.sessions.builder ? '' : 'Build the spec.'
  }

  private async build(job: Job, signal: AbortSignal): Promise<boolean> {
    const { machine, store, gate } = this.o
    const resuming = !job.sessions.builder && (await store.read(job.id, 'build.md')) !== null
    const purpose = [this.buildPurpose(job), resuming ? 'A previous builder stopped mid-round: read build.md and git log to see how far it got.' : '']
      .filter(Boolean).join(' ')
    // a record from an earlier build of this job must never stand in for this one's
    this.stopChecks.delete(job.id)
    const stopCheck = async () => {
      this.stopChecks.delete(job.id)
      const { git } = this.o.ports
      const before = await git.head(job.worktree)
      const cleanBefore = await git.isClean(job.worktree)
      const checks = await gate.runChecks(job.worktree, signal)
      const after = await git.head(job.worktree)
      this.stopChecks.set(job.id, { ...checks, round: job.round, before, cleanBefore, after })
      if (checks.code === 0) return null
      const tail = checks.output.trimEnd().split('\n').slice(-40).join('\n')
      return `.factory/checks.sh fails in your worktree (exit ${checks.code}); the gate will reject this build. `
        + `Fix it, or write STATUS: BLOCKED in build.md if you can't.\n\n${tail}`
    }
    const report = store.path(job.id, 'build.md')
    // the first line the factory couldn't read, so the second try is told that rather than a gate refusal
    let invalid: string | null = null
    const runBuilder = async (j: Job, why: string, again = false) => {
      const before = await mtime(report)
      const run = await this.runAgent(j, 'builder', signal, why, { stopCheck }, { again })
      return async () => {
        // last round's READY must not pass for this round's
        if (before !== null && before === await mtime(report)) {
          throw new Refused(`build.md wasn't updated in this run; rewrite it for round ${job.round}`)
        }
        invalid = run.invalid
        if (invalid) throw new Refused(invalid)
      }
    }
    let updated = await runBuilder(job, purpose)
    const toGate = async () => {
      await updated()
      if (firstLine(await store.read(job.id, 'build.md') ?? '') === 'STATUS: BLOCKED') {
        this.stopChecks.delete(job.id)
        await machine.advance(job.id, 'needs-human')
      } else {
        await machine.advance(job.id, 'gate')
      }
    }
    try {
      await toGate()
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      // the builder's one second try, whatever was refused: tell the same builder what
      const why = invalid ? this.fixReport(job, 'builder', invalid) : `The factory refused to gate this build: ${err.message}. Fix that and update build.md.`
      updated = await runBuilder(await store.load(job.id), why, true)
      await toGate()
    }
    return true
  }

  private async review(job: Job, signal: AbortSignal): Promise<boolean> {
    const { machine, store } = this.o
    const lenses = Object.keys(job.agents?.reviewers ?? {})
    const written = async (r: string) => (await lstat(store.path(job.id, `round-${job.round}/review-${r}.md`)).catch(() => null))?.isFile()
    // a review with no verdict counts as missing, so its lens runs again instead of blocking every retry
    for (const r of lenses) {
      const rel = `round-${job.round}/review-${r}.md`
      if (!await written(r) || VERDICTS.includes(firstLine(await store.read(job.id, rel) ?? ''))) continue
      await rm(store.path(job.id, rel))
      this.send({ type: 'log', message: `${job.id}: ${rel} has no verdict on its first line; removed it, so reviewer-${r} runs again` })
    }
    // a resumed review may already have some verdicts on disk
    this.send({ type: 'job', job: await store.update(job.id, j => machine.sync(j)) })
    const missing: string[] = []
    for (const r of lenses) if (!await written(r)) missing.push(r)
    // One at a time: with reviewers side by side, the watch could not tell
    // which of them wrote a verdict, so one could overwrite another's.
    for (const r of missing) {
      await this.agent(job, `reviewer-${r}` as AgentName, signal, `Review round ${job.round}.`)
      // show each verdict on the board as it lands
      this.send({ type: 'job', job: await store.update(job.id, j => machine.sync(j)) })
    }
    const synced = await machine.sync(await store.load(job.id))
    const changes = Object.values(synced.reviews).some(v => v === 'CHANGES')
    if (!changes) await machine.advance(job.id, 'approve')
    else await machine.advance(job.id, job.round >= job.roundLimit ? 'needs-human' : 'build')
    return true
  }

  // ---- Agents -------------------------------------------------------------

  private header(job: Job) {
    const { paths, config } = this.o
    return `Job: ${job.id}. Job folder: ${join(paths.jobs, job.id)}/. Main checkout: ${paths.repo}. `
      + `Worktree: ${job.worktree}. Branch: ${job.branch}. Base: origin/${config.baseBranch}. Issue: #${job.issue}.`
  }

  private port(job: Job, agent: AgentName): number | null {
    const offset = ({ 'builder': 0, 'reviewer-ux': 1, 'reviewer-ui': 2 } as Partial<Record<AgentName, number>>)[agent]
    if (offset === undefined) return null
    const { base, step } = this.o.config.ports
    return base + step * Number.parseInt(job.id, 10) + offset
  }

  /** A prompt override counts only once it is committed on the base, where no agent can write it. */
  private async prompt(agent: AgentName): Promise<string> {
    const { paths, ports, config } = this.o
    // an agent can move the local origin/<base>; fetching first puts it back
    await ports.git.fetch(paths.repo, config.baseBranch)
    const override = await ports.git.show(paths.repo, `refs/remotes/origin/${config.baseBranch}`, `.factory/agents/${agent}.md`)
    return override ?? PROMPTS[agent]
  }

  private model(job: Job, agent: AgentName): string {
    const { models } = this.o.config
    if (agent === 'intake') return models.intake
    if (agent === 'spec-writer') return models.spec
    if (agent === 'builder') return models.builder
    if (agent === 'approver') return models.approver
    const lens = agent.slice('reviewer-'.length)
    const model = job.agents?.reviewers[lens]
    if (!model) throw new Refused(`${job.id} has no model routed for ${agent}`)
    return model
  }

  /** The one file each agent reports in. */
  private report(job: Job, agent: AgentName): string {
    const file = REPORT_FILE[agent] ?? `round-${job.round}/review-${agent.slice('reviewer-'.length)}.md`
    return join(this.o.paths.jobs, job.id, file)
  }

  /** The folder the UX and UI reviewers keep this round's screenshots in; no other agent has one. */
  private screenshots(job: Job, agent: AgentName): string | null {
    if (agent !== 'reviewer-ux' && agent !== 'reviewer-ui') return null
    return join(this.o.paths.jobs, job.id, `round-${job.round}`, `screenshots-${agent.slice('reviewer-'.length)}`)
  }

  private writable(job: Job, agent: AgentName): string[] {
    const report = this.report(job, agent)
    const shots = this.screenshots(job, agent)
    if (agent === 'builder') return [`${job.worktree}/`, report]
    return shots ? [report, `${shots}/`] : [report]
  }

  /**
   * Agents end by replying with their report's first line. A report whose
   * verdict says otherwise was rewritten by something else while the agent ran
   * (a process a builder left behind), so it is refused, not trusted.
   */
  private async matchesReply(job: Job, agent: AgentName, reply: string) {
    const said = firstLine(reply)
    const report = this.report(job, agent)
    if (!isHead(agent, said) || !existsSync(report)) return
    const wrote = firstLine(await readFile(report, 'utf8'))
    if (isHead(agent, wrote) && wrote !== said) {
      throw new Error(`${agent} replied '${said}' but ${relative(this.o.store.dir(job.id), report)} starts with '${wrote}'; it was changed behind the agent`)
    }
  }

  /**
   * Agents sometimes end with their report as the final reply instead of
   * writing it. When the reply is a well-formed report, keep it rather than
   * stalling the job over a missing file.
   */
  private async keepRepliedReport(job: Job, agent: AgentName, reply: string) {
    const report = this.report(job, agent)
    if (existsSync(report) || !isHead(agent, firstLine(reply))) return
    await mkdir(dirname(report), { recursive: true })
    await writeFile(report, `${reply.trimEnd()}\n`)
    this.send({ type: 'log', message: `${job.id}: ${agent} replied with its report instead of writing it; saved it` })
  }

  /** Why the factory can't read an agent's report, naming the file; null when it can. */
  private async reportError(job: Job, agent: AgentName): Promise<string | null> {
    const report = this.report(job, agent)
    const rel = relative(this.o.store.dir(job.id), report)
    const text = await readFile(report, 'utf8').catch(() => null)
    if (agent === 'spec-writer') {
      if (text !== null && section(text, 'Acceptance criteria') !== null) return null
      return `${rel}: ${text === null ? 'the file is missing; it' : 'the file'} must contain a \`## Acceptance criteria\` heading`
    }
    const must = `your report's first line must be ${either(REPORT_HEAD[agent] ?? [])}`
    if (text === null) return `${rel}: the file is missing; ${must}`
    const line = firstLine(text)
    if (isHead(agent, line)) return null
    return `${rel}: ${must}; it is ${line ? quote(line) : 'empty'}`
  }

  /** What a second run is told about its report; the path is absolute so a fresh session can find it too. */
  private fixReport(job: Job, agent: AgentName, error: string): string {
    return `The factory can't use your report: ${error}. Fix ${this.report(job, agent)} and reply with its first line.`
  }

  /**
   * Agents have a shell, so the write list alone doesn't hold. Snapshots what
   * an agent may not change, and after it runs undoes and refuses any change to
   * the job folder beyond its report, or to the branch by an agent that only reads.
   */
  private async watch(job: Job, agent: AgentName) {
    const { git } = this.o.ports
    const dir = this.o.store.dir(job.id)
    const own = relative(dir, this.report(job, agent))
    const shots = this.screenshots(job, agent)
    // strictly inside: the folder itself replaced by a link is refused like any other added path
    const inside = shots ? `${relative(dir, shots)}/` : null
    const allowed = (rel: string) => rel === own || (inside !== null && rel.startsWith(inside))
    const readsBranch = agent !== 'builder' && agent !== 'intake' && existsSync(job.worktree)
    const files = await snapshot(dir)
    const fields = await this.o.store.load(job.id)
    const branch = readsBranch ? { head: await git.head(job.worktree), clean: await git.isClean(job.worktree) } : null
    return {
      check: async () => {
        const now = await snapshot(dir)
        const changes: string[] = []
        for (const [rel, entry] of files) {
          if (allowed(rel) || same(entry, now.get(rel))) continue
          changes.push(`${rel} (${now.has(rel) ? 'changed' : 'deleted'})`)
          if ('file' in entry) {
            await this.o.store.write(job.id, rel, entry.file)
          } else {
            await rm(join(dir, rel), { recursive: true, force: true })
            await symlink(entry.link, join(dir, rel))
          }
        }
        for (const [rel, entry] of now) {
          if (allowed(rel) ? !('link' in entry) : files.has(rel)) continue
          changes.push(`${rel} (added)`)
          await rm(join(dir, rel), { force: true })
        }
        const after = await this.o.store.load(job.id)
        if (trusted(after) !== trusted(fields)) {
          const bad = TRUSTED.filter(k => JSON.stringify(after[k]) !== JSON.stringify(fields[k]))
          await this.o.store.update(job.id, j => ({ ...j, ...Object.fromEntries(TRUSTED.map(k => [k, fields[k]])) }))
          throw new Error(`${agent} changed job.json fields it may not: ${bad.join(', ')}; the factory undid it`)
        }
        if (changes.length) {
          throw new Error(`${agent} changed job files it may not: ${changes.sort().join(', ')}; the factory undid it`)
        }
        if (branch && (await git.head(job.worktree) !== branch.head || await git.isClean(job.worktree) !== branch.clean)) {
          throw new Error(`${agent} changed the worktree (HEAD or uncommitted files); it may only read the branch`)
        }
      }
    }
  }

  /**
   * Runs an agent, and once more in the same session when its report is
   * missing or unreadable, told why; a second bad report stalls the job.
   * The builder's one second try is in `build()`, so it is never re-prompted here.
   */
  private async agent(job: Job, agent: AgentName, signal: AbortSignal, purpose = '',
    extra: Pick<AgentTask, 'stopCheck'> = {}) {
    const first = await this.runAgent(job, agent, signal, purpose, extra)
    if (!first.invalid || agent === 'builder') return first.result
    const sessionId = first.result.sessionId
    const fix = this.fixReport(job, agent, first.invalid)
    // nothing to resume: a fresh session needs the first run's brief as well
    const second = await this.runAgent(job, agent, signal, sessionId ? fix : [purpose, fix].filter(Boolean).join(' '), extra,
      { resume: sessionId ?? undefined, again: true })
    if (second.invalid) throw new Refused(second.invalid)
    return second.result
  }

  /**
   * One agent run and its checks. `again` marks a second run of the same
   * session, whose cost adds to the first instead of replacing it.
   */
  private async runAgent(job: Job, agent: AgentName, signal: AbortSignal, purpose: string,
    extra: Pick<AgentTask, 'stopCheck'>, opts: { resume?: string, again?: boolean } = {}) {
    const { store, paths, ports } = this.o
    const port = this.port(job, agent)
    const lead = agent === 'builder' ? `Build round ${job.round}.` : ''
    const shots = this.screenshots(job, agent)
    // made up front: screenshot tools run through Bash rarely create the folder
    if (shots) await mkdir(shots, { recursive: true })
    const message = [this.header(job), lead, port === null ? '' : `Port: ${port}.`, purpose,
      `Write your report to ${this.report(job, agent)}.`, shots ? `Save screenshots in ${shots}/.` : ''].filter(Boolean).join(' ')
    const resume = opts.resume ?? (agent === 'builder' ? job.sessions.builder : undefined)
    const task: AgentTask = {
      agent,
      jobId: job.id,
      jobDir: join(paths.jobs, job.id),
      round: job.round,
      model: this.model(job, agent),
      cwd: agent === 'intake' ? paths.repo : job.worktree,
      systemPrompt: await this.prompt(agent),
      message,
      tools: TOOLS[agent],
      writable: this.writable(job, agent),
      branch: job.branch,
      maxTurns: this.o.config.limits.agentTurns,
      maxBudgetUsd: this.o.config.limits.agentBudgetUsd,
      resume,
      signal,
      onEvent: event => this.send({ type: 'agent', jobId: job.id, agent, event }),
      ...extra
    }
    this.send({ type: 'log', message: `${job.id}: ${agent} started` })
    // logged outside the watch, so the factory's own lines are never taken for the agent's
    const run = { agent, model: task.model, round: job.round }
    await store.appendEvent(job.id, { at: ports.now(), type: 'agent-start', ...run })
    const t0 = performance.now()
    let cost = 0
    const end = (ok: boolean, error?: string) => store.appendEvent(job.id, {
      at: ports.now(), type: 'agent-end', ...run, seconds: Math.round((performance.now() - t0) / 1000), cost, ok, ...(error === undefined ? {} : { error })
    })
    try {
      const watch = await this.watch(job, agent)
      const result = await this.o.runner.run(task)
      cost = result.costUsd
      await store.update(job.id, (j) => {
        const costs = { ...j.costs }
        const sessions = { ...j.sessions }
        if (result.sessionId) {
          costs[result.sessionId] = (opts.again ? costs[result.sessionId] ?? 0 : 0) + result.costUsd
          if (agent === 'builder') sessions.builder = result.sessionId
        }
        const costUsd = Math.round(Object.values(costs).reduce((a, b) => a + b, 0) * 100) / 100
        return { ...j, costs, sessions, costUsd }
      })
      await watch.check()
      if (signal.aborted) throw new Error(`${agent} cancelled`)
      if (!result.ok) throw new Error(`${agent} failed: ${result.error ?? 'unknown error'}`)
      await this.matchesReply(job, agent, result.reply)
      await this.keepRepliedReport(job, agent, result.reply)
      this.send({ type: 'log', message: `${job.id}: ${agent} → ${result.reply.split('\n')[0]}` })
      const invalid = await this.reportError(job, agent)
      await end(!invalid, invalid ?? undefined)
      return { result, invalid }
    } catch (err) {
      await end(false, redact((err as Error).message))
      throw err
    }
  }
}
