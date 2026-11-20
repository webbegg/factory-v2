import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROMPTS } from './agents/prompts'
import type { AgentName } from './agents/prompts'
import type { AgentEvent, AgentRunner, AgentTask } from './agents/runner'
import type { Gate } from './gate'
import { firstLine } from './markdown'
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

/** First line of a valid report, per agent; the spec has no verdict line, so it has no fallback. */
const REPORT_HEAD: Partial<Record<AgentName, RegExp>> = {
  'intake': /^DECISION: (ACCEPT|NEEDS-INFO|REJECT)$/,
  'builder': /^STATUS: (READY|BLOCKED)$/,
  'approver': /^(APPROVE|ESCALATE)$/,
  'reviewer-code': /^VERDICT: (PASS|CHANGES)$/,
  'reviewer-security': /^VERDICT: (PASS|CHANGES)$/,
  'reviewer-ux': /^VERDICT: (PASS|CHANGES)$/,
  'reviewer-ui': /^VERDICT: (PASS|CHANGES)$/
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
  /** last failure per job; the drain leaves these alone until `retry` */
  readonly errors = new Map<string, string>()
  /** issues run while every slot was busy, oldest first; like `errors`, gone on restart */
  private pending: number[] = []

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

  async reject(id: string, text: string): Promise<Job> {
    const job = await this.o.machine.reject(id, text, await this.o.ports.github.operator())
    this.send({ type: 'job', job })
    return job
  }

  /** The operator answers intake's questions on the issue; the job goes back to intake. */
  async answer(id: string, text: string, reply: (issue: number, body: string) => Promise<void>): Promise<Job> {
    const job = await this.o.store.load(id)
    if (job.stage !== 'needs-info') throw new Refused(`${id} is in ${job.stage}, not needs-info`)
    await reply(job.issue, text)
    const next = await this.o.machine.advance(id, 'intake')
    this.start(id)
    return next
  }

  /** Restart a stalled job from its stage. */
  retry(id: string) {
    this.start(id)
  }

  cancel(id: string) {
    this.active.get(id)?.controller.abort()
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
    await this.startPending()
    if (!this.draining) return
    for (const row of await this.o.queue.rows()) {
      if (row.action === 'new') {
        const job = await this.o.queue.create(row.issue)
        this.start(job.id)
      } else if (row.action === 'resume' && row.job && !this.active.has(row.job) && !this.errors.has(row.job)) {
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
    if (this.active.has(id)) return
    const controller = new AbortController()
    this.errors.delete(id)
    const done = this.drive(id, controller.signal)
      .catch((err: Error) => {
        this.errors.set(id, err.message)
        this.send({ type: 'error', jobId: id, message: err.message })
      })
      .finally(async () => {
        this.active.delete(id)
        await this.tick()
        if (!this.active.size) this.send({ type: 'idle' })
      })
    this.active.set(id, { controller, done })
  }

  private async drive(id: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const job = await this.o.store.load(id)
      this.send({ type: 'job', job })
      if (!await this.step(job, signal)) return
    }
  }

  // ---- Stages -------------------------------------------------------------

  /** Runs the work of the job's stage and moves it on. False when it waits or is done. */
  private async step(job: Job, signal: AbortSignal): Promise<boolean> {
    const { machine, gate, merger, store, config } = this.o
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
        const result = await gate.run(job.id)
        this.send({ type: 'log', message: result.line })
        if (result.verdict === 'PASS') await machine.advance(job.id, 'review')
        else await machine.advance(job.id, job.round >= job.roundLimit ? 'needs-human' : 'build')
        return true
      }
      case 'review':
        return this.review(job, signal)
      case 'approve': {
        await this.agent(job, 'approver', signal, `PR: #${job.pr}. Final round: ${job.round}.`)
        const line = firstLine(await store.read(job.id, 'decision.md') ?? '')
        if (line === 'APPROVE') await merger.merge(job.id)
        else await machine.advance(job.id, 'needs-human')
        return true
      }
      case 'merging':
        await merger.merge(job.id)
        return true
      default:
        return false
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
    const stopCheck = async () => {
      const checks = await gate.runChecks(job.worktree)
      if (checks.code === 0) return null
      const tail = checks.output.trimEnd().split('\n').slice(-40).join('\n')
      return `.factory/checks.sh fails in your worktree (exit ${checks.code}); the gate will reject this build. `
        + `Fix it, or write STATUS: BLOCKED in build.md if you can't.\n\n${tail}`
    }
    await this.agent(job, 'builder', signal, purpose, { stopCheck })
    const status = firstLine(await store.read(job.id, 'build.md') ?? '')
    if (status === 'STATUS: BLOCKED') {
      await machine.advance(job.id, 'needs-human')
      return true
    }
    try {
      await machine.advance(job.id, 'gate')
    } catch (err) {
      if (!(err instanceof Refused)) throw err
      // one more try: tell the same builder what the factory refused
      await this.agent(await store.load(job.id), 'builder', signal,
        `The factory refused to gate this build: ${err.message}. Fix that and update build.md.`, { stopCheck })
      await machine.advance(job.id, 'gate')
    }
    return true
  }

  private async review(job: Job, signal: AbortSignal): Promise<boolean> {
    const { machine, store } = this.o
    // a resumed review may already have some verdicts on disk
    this.send({ type: 'job', job: await store.update(job.id, j => machine.sync(j)) })
    const lenses = Object.keys(job.agents?.reviewers ?? {})
    const missing = lenses.filter(r => !existsSync(store.path(job.id, `round-${job.round}/review-${r}.md`)))
    await Promise.all(missing.map(async (r) => {
      await this.agent(job, `reviewer-${r}` as AgentName, signal, `Review round ${job.round}.`)
      // show each verdict on the board as it lands, not when the slowest reviewer ends
      this.send({ type: 'job', job: await store.update(job.id, j => machine.sync(j)) })
    }))
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

  private async prompt(agent: AgentName): Promise<string> {
    const override = join(this.o.paths.factory, 'agents', `${agent}.md`)
    return existsSync(override) ? readFile(override, 'utf8') : PROMPTS[agent]
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

  private writable(job: Job, agent: AgentName): string[] {
    const report = this.report(job, agent)
    return agent === 'builder' ? [`${job.worktree}/`, report] : [report]
  }

  /**
   * Agents sometimes end with their report as the final reply instead of
   * writing it. When the reply is a well-formed report, keep it rather than
   * stalling the job over a missing file.
   */
  private async keepRepliedReport(job: Job, agent: AgentName, reply: string) {
    const report = this.report(job, agent)
    const head = REPORT_HEAD[agent]
    if (existsSync(report) || !head?.test(firstLine(reply))) return
    await mkdir(dirname(report), { recursive: true })
    await writeFile(report, `${reply.trimEnd()}\n`)
    this.send({ type: 'log', message: `${job.id}: ${agent} replied with its report instead of writing it; saved it` })
  }

  private async agent(job: Job, agent: AgentName, signal: AbortSignal, purpose = '',
    extra: Pick<AgentTask, 'stopCheck'> = {}) {
    const { store, paths } = this.o
    const port = this.port(job, agent)
    const lead = agent === 'builder' ? `Build round ${job.round}.` : ''
    const message = [this.header(job), lead, port === null ? '' : `Port: ${port}.`, purpose,
      `Write your report to ${this.report(job, agent)}.`].filter(Boolean).join(' ')
    const resume = agent === 'builder' ? job.sessions.builder : undefined
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
      resume,
      signal,
      onEvent: event => this.send({ type: 'agent', jobId: job.id, agent, event }),
      ...extra
    }
    this.send({ type: 'log', message: `${job.id}: ${agent} started` })
    const result = await this.o.runner.run(task)
    await store.update(job.id, (j) => {
      const costs = { ...j.costs }
      const sessions = { ...j.sessions }
      if (result.sessionId) {
        costs[result.sessionId] = result.costUsd
        if (agent === 'builder') sessions.builder = result.sessionId
      }
      const costUsd = Math.round(Object.values(costs).reduce((a, b) => a + b, 0) * 100) / 100
      return { ...j, costs, sessions, costUsd }
    })
    if (signal.aborted) throw new Error(`${agent} cancelled`)
    if (!result.ok) throw new Error(`${agent} failed: ${result.error ?? 'unknown error'}`)
    await this.keepRepliedReport(job, agent, result.reply)
    this.send({ type: 'log', message: `${job.id}: ${agent} → ${result.reply.split('\n')[0]}` })
    return result
  }
}
