import { join } from 'node:path'
import { renderIssue, repliedSinceQuestion } from './issue'
import { holdsSlot, Refused, TERMINAL } from './machine'
import type { Machine } from './machine'
import type { Ports } from './ports'
import { hash } from './provenance'
import type { BuildInfo } from './provenance'
import type { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, Job, JobProvenance, Stage } from './types'

export type QueueAction = 'resume' | 'new' | 'hold' | 'wait' | 'skip'

export interface QueueRow {
  action: QueueAction
  issue: number
  job: string | null
  stage: Stage | null
  note: string
}

export interface QueueOptions {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  ports: Ports
  machine: Machine
  build: BuildInfo
}

export function slugify(title: string): string {
  return (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 4).join('-') || 'issue'
}

/**
 * What a run should do with each labeled issue. Jobs in a running stage hold
 * a concurrency slot whether or not an agent is on them; only as many new and
 * replied needs-info rows as there are free slots come out runnable.
 */
export class Queue {
  constructor(private o: QueueOptions) {}

  /**
   * A job is done once its PR is merged on GitHub, by us or by a person. Moving
   * it removes its worktree, so jobs the caller is driving are left to it.
   * `only` limits the sweep to jobs in that stage.
   */
  async sweepMerged(driving: (id: string) => boolean, only?: Stage): Promise<void> {
    const { store, ports, machine } = this.o
    for (const j of await store.list()) {
      if (only && j.stage !== only) continue
      if (!TERMINAL.has(j.stage) && !driving(j.id) && j.pr && await ports.github.prState(j.pr) === 'MERGED') {
        await machine.advance(j.id, 'merged')
      }
    }
  }

  /** Read-only: what a run would do with each labeled issue. */
  async rows(): Promise<QueueRow[]> {
    const { store, ports, config } = this.o
    const { github } = ports
    const queueLabel = config.labels.queue
    const jobs = await store.list()
    const byIssue = new Map(jobs.map(j => [j.issue, j]))
    const issues = (await github.listIssues(queueLabel)).sort((a, b) => a.number - b.number)
    const open = new Set(issues.map(i => i.number))
    const operator = await github.operator()

    const running: QueueRow[] = []
    const candidates: QueueRow[] = []
    const others: QueueRow[] = []
    const row = (action: QueueAction, issue: number, job: Job | null, note: string): QueueRow =>
      ({ action, issue, job: job?.id ?? null, stage: job?.stage ?? null, note })

    for (const issue of issues) {
      const j = byIssue.get(issue.number)
      if (!j) {
        candidates.push(row('new', issue.number, null, issue.title))
      } else if (j.stage === 'needs-info') {
        if (repliedSinceQuestion(await github.fetchIssue(issue.number), operator)) {
          candidates.push(row('resume', issue.number, j, 'author replied'))
        } else {
          others.push(row('wait', issue.number, j, 'waiting for the author'))
        }
      } else if (j.stage === 'needs-human') {
        others.push(row('wait', issue.number, j, j.pr ? `merge PR #${j.pr}, or give feedback` : 'give feedback'))
      } else if (j.stage === 'rejected') {
        // both rejection paths remove the label, so a labeled issue here was labeled again since
        others.push(row('skip', issue.number, j, 're-labeled after rejection: Run again on the board'))
      } else if (j.stage === 'merged') {
        others.push(row('skip', issue.number, j, 'merged'))
      } else if (j.paused) {
        others.push(row('skip', issue.number, j, 'paused: Resume on the board'))
      } else {
        running.push(row('resume', issue.number, j, `round ${j.round}`))
      }
    }
    for (const j of jobs) {
      if (!open.has(j.issue) && holdsSlot(j)) {
        others.push(row('skip', j.issue, j, `issue is closed or no longer labeled ${queueLabel}`))
      }
    }

    let slots = config.concurrency - jobs.filter(holdsSlot).length
    const slotted = candidates.map((r) => {
      if (slots > 0) {
        slots -= 1
        return r
      }
      return { ...r, action: 'hold' as const, note: `concurrency ${config.concurrency} reached` }
    })
    return [...running, ...slotted, ...others]
  }

  /** Refuses an issue that could never get a job, whatever the free slots. */
  async admit(number: number): Promise<void> {
    this.refuseExisting(await this.o.store.list(), number)
    await this.openLabeled(number)
  }

  /** Slots not held by a job; negative when the limit was lowered below the running count. */
  async freeSlots(): Promise<number> {
    return this.o.config.concurrency - (await this.o.store.list()).filter(holdsSlot).length
  }

  private refuseExisting(jobs: Job[], number: number) {
    const existing = jobs.find(j => j.issue === number)
    if (existing) throw new Refused(`issue #${number} already has job ${existing.id} (${existing.stage})`)
  }

  private async openLabeled(number: number) {
    const { ports, config } = this.o
    const issue = await ports.github.fetchIssue(number)
    if (issue.state !== 'OPEN') throw new Refused(`issue #${number} is ${issue.state.toLowerCase()}`)
    if (!issue.labels.includes(config.labels.queue)) {
      throw new Refused(`issue #${number} isn't labeled ${config.labels.queue}`)
    }
    return issue
  }

  /** Best effort: a read that fails leaves only its own field null, never stopping the job. */
  private async provenance(): Promise<JobProvenance> {
    const { ports, config, paths, build } = this.o
    const base = config.baseBranch
    const ref = `refs/remotes/origin/${base}`
    // a failed fetch leaves the last fetched base, which the reads below then all describe
    await ports.git.fetch(paths.repo, base).catch(() => {})
    const onBase = async (path: string) => {
      const text = await ports.git.show(paths.repo, ref, path).catch(() => null)
      return text === null ? null : hash(text)
    }
    return {
      ...build,
      baseSha: await ports.git.remoteHead(paths.repo, base).catch(() => null),
      configSha: await onBase('.factory/config.json'),
      checksSha: await onBase('.factory/checks.sh'),
      sandbox: config.sandbox.enabled
    }
  }

  /** A new job for an open, labeled issue, starting at intake. */
  async create(number: number): Promise<Job> {
    const { store, ports, config, paths } = this.o
    const jobs = await store.list()
    this.refuseExisting(jobs, number)
    const busy = jobs.filter(holdsSlot).map(j => j.id)
    if (busy.length >= config.concurrency) {
      throw new Refused(`concurrency ${config.concurrency} reached; running: ${busy.join(', ')}`)
    }
    const issue = await this.openLabeled(number)
    // archived folders count too, so a new job never reuses an old one's number, branch or worktree
    const numbers = (await store.entries()).map(name => Number.parseInt(name, 10)).filter(Number.isFinite)
    const next = Math.max(0, ...numbers) + 1
    const id = `${String(next).padStart(3, '0')}-${slugify(issue.title)}`
    const job: Job = {
      id,
      issue: issue.number,
      title: issue.title,
      issueUrl: issue.url,
      pr: null,
      prUrl: null,
      branch: `factory/${id}`,
      worktree: join(paths.worktrees, id),
      stage: 'intake',
      round: 0,
      roundLimit: config.maxRounds,
      intake: null,
      agents: null,
      gate: null,
      reviews: {},
      roundReason: null,
      sessions: {},
      costs: {},
      costUsd: 0,
      started: ports.now(),
      ended: null,
      error: null,
      paused: null,
      provenance: await this.provenance(),
      judged: {},
      decided: null
    }
    await store.write(id, 'issue.md', renderIssue(issue, await ports.github.operator()))
    await store.save(job)
    return job
  }
}
