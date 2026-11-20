import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { body, firstLine, header, section } from './markdown'
import type { Ports } from './ports'
import type { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, IntakeInfo, Job, JobAgents, Risk, RoundReason, Stage, Verdict } from './types'

/**
 * Legal stage moves. Any unfinished job may also move to `merged` once its PR
 * is merged on GitHub, by the factory or by a person mid-round.
 */
export const TRANSITIONS: Partial<Record<Stage, readonly Stage[]>> = {
  'intake': ['needs-info', 'rejected', 'spec'],
  'needs-info': ['intake', 'rejected'],
  'spec': ['build'],
  'build': ['gate', 'needs-human'],
  'gate': ['review', 'build', 'needs-human'],
  'review': ['approve', 'build', 'needs-human'],
  'approve': ['merging', 'needs-human'],
  'merging': ['needs-human'],
  'needs-human': ['build', 'rejected']
}

export const TERMINAL: ReadonlySet<Stage> = new Set(['merged', 'rejected'])
export const WAITING: ReadonlySet<Stage> = new Set(['needs-info', 'needs-human'])

/** A move the machine won't make; the message says why. */
export class Refused extends Error {
  override name = 'Refused'
}

function require(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Refused(message)
}

/** Jobs holding a concurrency slot: every job that isn't finished or waiting. */
export function holdsSlot(job: Job): boolean {
  return !TERMINAL.has(job.stage) && !WAITING.has(job.stage)
}

type Via = 'advance' | 'feedback' | 'reject'

export interface MachineOptions {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  ports: Ports
}

/**
 * The only writer of job.json. Every stage change is checked against the files
 * that justify it, and the GitHub and git side effects that belong to a move
 * happen here, so the orchestrator never improvises them.
 */
export class Machine {
  constructor(private o: MachineOptions) {}

  private get store() {
    return this.o.store
  }

  private get config() {
    return this.o.config
  }

  private get ports() {
    return this.o.ports
  }

  private roundRel(job: Job, n = job.round) {
    return `round-${n}`
  }

  /** Fields derived from the job's files: intake, gate verdict, reviews. */
  async sync(job: Job): Promise<Job> {
    const next = { ...job }
    const intake = await this.store.read(job.id, 'intake.md')
    if (intake !== null) next.intake = parseIntake(intake)
    if (job.round > 0) {
      const rd = this.roundRel(job)
      const checks = await this.store.read(job.id, `${rd}/checks.md`)
      const gate = checks === null ? undefined : header(checks).GATE
      next.gate = gate === 'PASS' || gate === 'FAIL' ? gate : null
      if (job.agents && ['review', 'approve', 'merging', 'merged', 'needs-human'].includes(job.stage)) {
        const reviews: Record<string, Verdict> = {}
        for (const r of Object.keys(job.agents.reviewers)) {
          const text = await this.store.read(job.id, `${rd}/review-${r}.md`)
          const m = text === null ? null : /^VERDICT:\s*(PASS|CHANGES)$/.exec(firstLine(text))
          reviews[r] = text === null ? 'pending' : m ? m[1] as Verdict : 'invalid'
        }
        next.reviews = reviews
      }
    }
    return next
  }

  advance(id: string, stage: Stage): Promise<Job> {
    return this.store.update(id, async job => this.transition(await this.sync(job), stage, 'advance'))
  }

  /** Records the routed agent set on an ACCEPTed intake job. */
  recordAgents(id: string, agents: JobAgents): Promise<Job> {
    return this.store.update(id, async (raw) => {
      const job = await this.sync(raw)
      require(job.stage === 'intake' && job.intake?.decision === 'ACCEPT',
        `${id}: route only an intake job that intake ACCEPTed`)
      return { ...job, agents }
    })
  }

  /** needs-human → build with the user's feedback as feedback-<k>.md. */
  async feedback(id: string, text: string, operator: string): Promise<{ job: Job, file: string }> {
    let file = ''
    const job = await this.store.update(id, async (raw) => {
      require(raw.stage === 'needs-human', `${id} is in ${raw.stage}, not needs-human`)
      require(text.trim(), 'no feedback given')
      const k = (await this.store.files(id, /^feedback-\d+\.md$/)).length + 1
      file = `feedback-${k}.md`
      await this.store.write(id, file, `# Feedback ${k}\n\nFrom @${operator} after the job escalated.\n\n${text.trim()}\n`)
      return this.transition(await this.sync(raw), 'build', 'feedback', file)
    })
    return { job, file }
  }

  /** needs-info or needs-human → rejected with the user's reason as rejection.md. */
  reject(id: string, text: string, operator: string): Promise<Job> {
    return this.store.update(id, async (raw) => {
      require(WAITING.has(raw.stage), `${id} is in ${raw.stage}, not needs-info or needs-human`)
      require(text.trim(), 'no reason given')
      await this.store.write(id, 'rejection.md',
        `REJECTED\n\nBy @${operator} while the job was ${raw.stage}.\n\n${text.trim()}\n`)
      return this.transition(await this.sync(raw), 'rejected', 'reject')
    })
  }

  private async requireSlot(id: string) {
    const busy = (await this.store.list()).filter(j => j.id !== id && holdsSlot(j)).map(j => j.id)
    require(busy.length < this.config.concurrency,
      `concurrency ${this.config.concurrency} reached; running: ${busy.join(', ')}`)
  }

  private async nextRound(job: Job, reason: RoundReason) {
    job.round += 1
    job.roundReason = reason
    job.gate = null
    job.reviews = {}
    await mkdir(this.store.path(job.id, this.roundRel(job)), { recursive: true })
  }

  private async escalate(job: Job, why: string) {
    await this.store.write(job.id, 'decision.md', `ESCALATE\n\n## Why\n${why}\n`)
  }

  private async read(job: Job, rel: string) {
    return this.store.read(job.id, rel)
  }

  private lastRoundCheck(job: Job, stage: Stage) {
    const last = job.round >= job.roundLimit
    require(last === (stage === 'needs-human'),
      `round ${job.round} of ${job.roundLimit}: go to ${last ? 'needs-human' : 'build'}`)
    return last
  }

  private async transition(input: Job, stage: Stage, via: Via, feedbackFile?: string): Promise<Job> {
    const job = { ...input }
    const old = job.stage
    const { github, git, issues } = this.ports
    const { labels, baseBranch: base } = this.config
    require((TRANSITIONS[old] ?? []).includes(stage) || (stage === 'merged' && !TERMINAL.has(old)),
      `${job.id}: ${old} → ${stage} is not a legal transition`)

    if (stage === 'merged') {
      require(job.pr && await github.prState(job.pr) === 'MERGED', 'the PR isn\'t merged')
      if (old === 'needs-human') await github.editLabels('issue', job.issue, { remove: [labels.needsHuman] })
    } else if (stage === 'rejected' && WAITING.has(old)) {
      require(via === 'reject', 'use reject to reject a waiting job')
      const reason = body(await this.read(job, 'rejection.md') ?? '')
      const reasonText = reason.split('\n\n').slice(1).join('\n\n').trim() || reason
      await github.comment('issue', job.issue, `### Factory: rejected\n\n${reasonText}`)
      const waiting = old === 'needs-info' ? labels.needsInfo : labels.needsHuman
      await github.editLabels('issue', job.issue, { remove: [labels.queue, waiting] })
      if (job.pr) {
        await github.prClose(job.pr)
        await git.deleteRemoteBranch(job.branch)
      }
    } else if (old === 'intake') {
      await this.leaveIntake(job, stage)
    } else if (old === 'needs-info') {
      await this.requireSlot(job.id)
      const k = (await this.store.files(job.id, /^intake-\d+\.md$/)).length + 1
      await this.store.move(job.id, 'intake.md', `intake-${k}.md`)
      job.intake = null
      await issues.refresh(job)
      await github.editLabels('issue', job.issue, { remove: [labels.needsInfo] })
    } else if (old === 'spec') {
      require(await this.read(job, 'spec.md') !== null, 'spec.md doesn\'t exist')
      await this.nextRound(job, 'spec')
    } else if (old === 'build' && stage === 'gate') {
      const status = firstLine(await this.read(job, 'build.md') ?? '')
      require(status === 'STATUS: READY', `build.md starts with '${status}', not STATUS: READY`)
      require(await git.isClean(job.worktree), 'the worktree has uncommitted changes')
      require(await git.commitsAhead(job.worktree, `origin/${base}`) > 0,
        `${job.branch} has no commits on top of origin/${base}`)
      await git.fetch(job.worktree, job.branch)
      const head = await git.head(job.worktree)
      const remote = await git.remoteHead(job.worktree, job.branch)
      require(head === remote,
        `${job.branch} isn't pushed: local ${head.slice(0, 7)}, origin ${remote?.slice(0, 7) ?? 'missing'}`)
      if (!job.pr) {
        const prs = await github.openPrsForBranch(job.branch)
        require(prs.length === 1, `expected one open PR from ${job.branch}, found ${prs.length}`)
        job.pr = prs[0]!.number
        job.prUrl = prs[0]!.url
      }
    } else if (old === 'build') { // → needs-human
      const build = await this.read(job, 'build.md') ?? ''
      require(firstLine(build) === 'STATUS: BLOCKED',
        `build.md starts with '${firstLine(build)}', not STATUS: BLOCKED`)
      await this.escalate(job, 'The builder is blocked:\n\n' + (section(build, 'Blocked') ?? '(no Blocked section)'))
    } else if (old === 'gate') {
      const checks = await this.read(job, `${this.roundRel(job)}/checks.md`)
      require(checks !== null, `run the gate first: factory gate ${job.id}`)
      const h = header(checks)
      require(h.COMMIT === await git.head(job.worktree), 'checks.md was written for another commit; run the gate again')
      if (stage === 'review') {
        require(h.GATE === 'PASS', 'the gate didn\'t pass')
        job.reviews = Object.fromEntries(Object.keys(job.agents?.reviewers ?? {}).map(r => [r, 'pending' as Verdict]))
      } else {
        require(h.GATE === 'FAIL', 'the gate passed')
        if (this.lastRoundCheck(job, stage)) {
          await this.escalate(job, `The gate failed in round ${job.round}, the last allowed round. `
          + `See round-${job.round}/checks.md.`)
        } else {
          await this.nextRound(job, 'gate')
        }
      }
    } else if (old === 'review') {
      const missing = Object.entries(job.reviews).filter(([, v]) => v === 'pending').map(([r]) => r)
      require(!missing.length, `round ${job.round} is missing reviews from: ${missing.join(', ')}`)
      const bad = Object.entries(job.reviews).find(([, v]) => v === 'invalid')
      require(!bad, `first line isn't a verdict in review-${bad?.[0]}.md`)
      const changes = Object.entries(job.reviews).filter(([, v]) => v === 'CHANGES').map(([r]) => r)
      if (stage === 'approve') {
        require(!changes.length, `reviews want CHANGES: ${changes.join(', ')}`)
      } else {
        require(changes.length, 'every review passed')
        if (this.lastRoundCheck(job, stage)) {
          await this.escalate(job, `Review rounds exhausted. Outstanding CHANGES in round-${job.round}/ `
          + `from: ${changes.join(', ')}.`)
        } else {
          await this.nextRound(job, 'review')
        }
      }
    } else if (old === 'approve') {
      const want = stage === 'merging' ? 'APPROVE' : 'ESCALATE'
      const line = firstLine(await this.read(job, 'decision.md') ?? '')
      require(line === want, `decision.md starts with '${line}', not ${want}`)
    } else if (old === 'needs-human') { // → build
      require(via === 'feedback' && feedbackFile, 'use feedback to send a job back to the builder')
      job.roundLimit = job.round + this.config.maxRounds
      await this.nextRound(job, `feedback:${feedbackFile}`)
      await github.editLabels('issue', job.issue, { remove: [labels.needsHuman] })
    }

    if (stage === 'needs-human') {
      const decision = await this.read(job, 'decision.md') ?? ''
      const text = `### Factory: needs a human\n\n${decision.split('\n').slice(1).join('\n').trim()}`
      if (job.pr) {
        if (await github.prIsDraft(job.pr)) await github.prReady(job.pr)
        await github.comment('pr', job.pr, text)
      } else {
        await github.comment('issue', job.issue, text)
      }
      await github.editLabels('issue', job.issue, { add: [labels.needsHuman] })
    }

    if (TERMINAL.has(stage) && existsSync(job.worktree)) {
      await git.removeWorktree(job.worktree)
      await git.deleteBranch(job.branch)
    }

    job.stage = stage
    job.ended = TERMINAL.has(stage) || WAITING.has(stage) ? this.ports.now() : null
    return job
  }

  private async leaveIntake(job: Job, stage: Stage) {
    const { github, git } = this.ports
    const { labels, baseBranch: base } = this.config
    const text = await this.read(job, 'intake.md') ?? ''
    const decision = job.intake?.decision ?? null
    const want = ({ 'needs-info': 'NEEDS-INFO', 'rejected': 'REJECT', 'spec': 'ACCEPT' } as Record<string, string>)[stage]
    require(decision === want, `intake.md says DECISION: ${decision}, not ${want}`)
    let title = `### Factory intake: ${decision}`
    if (stage === 'spec') {
      require(job.agents, `route the job first: factory route ${job.id}`)
      title += ` (risk ${job.intake?.risk}, surfaces: ${job.intake?.surfaces.join(', ') || 'none'})`
    }
    await github.comment('issue', job.issue, `${title}\n\n${body(text)}`)
    if (stage === 'needs-info') {
      await github.editLabels('issue', job.issue, { add: [labels.needsInfo] })
    } else if (stage === 'rejected') {
      await github.editLabels('issue', job.issue, { remove: [labels.queue] })
    } else {
      await git.fetch(this.o.paths.repo, base)
      await git.addWorktree(job.worktree, job.branch, `origin/${base}`)
    }
  }
}

function parseIntake(text: string): IntakeInfo {
  const h = header(text)
  const risk = h.RISK as Risk | undefined
  return {
    decision: h.DECISION ?? null,
    rescoped: h.RESCOPED === 'yes',
    risk: risk && ['low', 'medium', 'high'].includes(risk) ? risk : null,
    surfaces: (h.SURFACES ?? '').split(',').map(s => s.trim()).filter(s => s && s !== 'none')
  }
}
