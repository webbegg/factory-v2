import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isWritable } from './agents/runner'
import type { AgentResult, AgentRunner, AgentTask } from './agents/runner'
import type { AgentName } from './agents/prompts'
import { Orchestrator } from './orchestrator'
import type { FactoryEvent } from './orchestrator'
import { makeEnv } from './testing'
import type { TestEnv } from './testing'

/** returns an error message to fail the agent, `{ reply }` to answer with text, anything else to succeed */
type Script = (task: AgentTask, call: number) => unknown

/** Plays each agent by writing the file it would write. */
class FakeRunner implements AgentRunner {
  tasks: AgentTask[] = []
  active = 0
  maxActive = 0
  private counts = new Map<string, number>()
  constructor(private env: TestEnv, private scripts: Partial<Record<AgentName, Script>>) {}

  async run(task: AgentTask): Promise<AgentResult> {
    this.tasks.push(task)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await Bun.sleep(1)
    const n = (this.counts.get(`${task.jobId}/${task.agent}`) ?? 0) + 1
    this.counts.set(`${task.jobId}/${task.agent}`, n)
    try {
      const error: unknown = await this.scripts[task.agent]?.(task, n)
      if (typeof error === 'string') return { ok: false, reply: '', sessionId: null, costUsd: 0, error }
      const reply = (error as { reply?: string } | undefined)?.reply ?? 'done'
      return { ok: true, reply, sessionId: task.resume ?? `${task.jobId}-${task.agent}-${n}`, costUsd: 0.25 }
    } finally {
      this.active -= 1
    }
  }

  agents(jobId?: string) {
    return this.tasks.filter(t => !jobId || t.jobId === jobId).map(t => t.agent)
  }
}

const write = (task: AgentTask, rel: string, text: string) => writeFile(join(task.jobDir, rel), text)

const happy: Partial<Record<AgentName, Script>> = {
  'intake': t => write(t, 'intake.md', 'DECISION: ACCEPT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Summary\n- ok\n'),
  'spec-writer': t => write(t, 'spec.md', '# Spec\n'),
  'builder': async (t, _n) => {
    await write(t, 'build.md', 'STATUS: READY\n\n# Build\n')
  },
  'reviewer-code': t => write(t, `round-${t.round}/review-code.md`, 'VERDICT: PASS\n'),
  'approver': t => write(t, 'decision.md', 'APPROVE\n\n## Why\nok\n')
}

async function factory(scripts: Partial<Record<AgentName, Script>>, overrides = {}) {
  const env = await makeEnv(overrides)
  await mkdir(env.paths.factory, { recursive: true })
  await writeFile(join(env.paths.factory, 'checks.sh'), 'test ! -e "$PWD/broken"\n')
  const runner = new FakeRunner(env, scripts)
  const orch = new Orchestrator({ ...env, runner })
  // every builder's first push opens one PR per branch
  const builder = scripts.builder
  scripts.builder = async (t, n) => {
    const job = await env.store.load(t.jobId)
    env.github.openPrs.set(job.branch, [{ number: 100 + job.issue, url: `pr/${job.issue}` }])
    return builder?.(t, n)
  }
  return { env, runner, orch }
}

describe('isWritable', () => {
  test('exact files and folder prefixes ending in /', () => {
    expect(isWritable('/r/.factory/jobs/1/spec.md', ['/r/.factory/jobs/1/spec.md'])).toBe(true)
    expect(isWritable('/r/.factory/jobs/1/build.md', ['/r/.factory/jobs/1/spec.md'])).toBe(false)
    expect(isWritable('/r/.worktrees/1/src/a.ts', ['/r/.worktrees/1/'])).toBe(true)
    expect(isWritable('/r/.worktrees/1/../../x', ['/r/.worktrees/1/'])).toBe(false)
    expect(isWritable('/r/.worktrees/10/a', ['/r/.worktrees/1/'])).toBe(false)
  })
})

describe('orchestrator', () => {
  test('every agent is told the exact path of its report', async () => {
    const { env, runner, orch } = await factory({ ...happy })
    env.github.addIssue({ number: 1, title: 'Add subtract' })
    await orch.drain()
    await orch.idle()
    const review = runner.tasks.find(t => t.agent === 'reviewer-code')!
    expect(review.message).toContain(`Write your report to ${join(review.jobDir, 'round-1/review-code.md')}.`)
    const build = runner.tasks.find(t => t.agent === 'builder')!
    expect(build.message).toContain(`Write your report to ${join(build.jobDir, 'build.md')}.`)
  })

  test('a report answered as the final reply instead of written is saved for the agent', async () => {
    const report = 'VERDICT: PASS\n\n## Summary\n- fine'
    const { env, orch } = await factory({ ...happy, 'reviewer-code': () => ({ reply: report }) })
    env.github.addIssue({ number: 1, title: 'Add subtract' })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('merged')
    expect(await env.store.read(job.id, 'round-1/review-code.md')).toBe(`${report}\n`)
  })

  test('a final reply that is not a report is not saved, and the job stalls', async () => {
    const { env, orch } = await factory({ ...happy, 'reviewer-code': () => ({ reply: 'Looks good to me!' }) })
    env.github.addIssue({ number: 1, title: 'Add subtract' })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('review')
    expect(orch.errors.get(job.id)).toContain('missing reviews from: code')
  })

  test('drains one issue from intake to a merged PR', async () => {
    const { env, runner, orch } = await factory({ ...happy })
    env.github.addIssue({ number: 1, title: 'Add subtract' })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('merged')
    expect(runner.agents()).toEqual(['intake', 'spec-writer', 'builder', 'reviewer-code', 'approver'])
    expect(env.github.calls).toContainEqual(['merge', 101, 'merge'])
    expect(job.costUsd).toBe(1.25)
    expect(orch.errors.size).toBe(0)
  })

  test('agents get the job header, their model, cwd, tools and writable files', async () => {
    const { env, runner, orch } = await factory({ ...happy })
    env.github.addIssue({ number: 1, title: 'Add subtract' })
    await orch.drain()
    await orch.idle()
    const [intake, spec, builder, review] = runner.tasks
    const id = '001-add-subtract'
    const jobDir = join(env.paths.jobs, id)
    const wt = join(env.paths.worktrees, id)
    expect(intake!.message).toStartWith(`Job: ${id}. Job folder: ${jobDir}/. Main checkout: ${env.paths.repo}. Worktree: ${wt}. Branch: factory/${id}. Base: origin/main. Issue: #1.`)
    expect(intake).toMatchObject({ model: 'fable', cwd: env.paths.repo, tools: ['Read', 'Grep', 'Glob', 'Write'], writable: [`${jobDir}/intake.md`] })
    expect(spec).toMatchObject({ model: 'opus', cwd: wt, writable: [`${jobDir}/spec.md`] })
    expect(builder).toMatchObject({ model: 'opus', cwd: wt, writable: [`${wt}/`, `${jobDir}/build.md`] })
    expect(builder!.message).toContain('Build round 1. Port: 5110.')
    expect(builder!.stopCheck).toBeFunction()
    expect(review).toMatchObject({ model: 'haiku', writable: [`${jobDir}/round-1/review-code.md`] })
    expect(review!.message).toContain('Review round 1.')
  })

  test('review CHANGES sends the resumed builder back, then approves', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      'reviewer-code': (t, n) => write(t, `round-${t.round}/review-code.md`, n === 1 ? 'VERDICT: CHANGES\n' : 'VERDICT: PASS\n')
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('merged')
    const builds = runner.tasks.filter(t => t.agent === 'builder')
    expect(builds).toHaveLength(2)
    expect(builds[1]!.message).toContain('Build round 2. Port: 5110. Round 1 reviews are in round-1/. Address every VERDICT: CHANGES')
    expect(builds[1]!.resume).toBe('001-issue-1-builder-1')
  })

  test('a failing gate goes back to the builder without spawning reviewers', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      builder: async (t, n) => {
        if (n === 1) await writeFile(join(t.cwd, 'broken'), 'x')
        else await Bun.$`rm -f ${join(t.cwd, 'broken')}`.quiet()
        await write(t, 'build.md', 'STATUS: READY\n')
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect(runner.agents()).toEqual(['intake', 'spec-writer', 'builder', 'builder', 'reviewer-code', 'approver'])
    expect(runner.tasks[3]!.message).toContain('The gate failed: read round-1/checks.md and checks.log')
  })

  test('NEEDS-INFO parks the job and the drain goes idle', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      intake: t => write(t, 'intake.md', 'DECISION: NEEDS-INFO\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Questions\n1. Which?\n')
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('needs-info')
    expect(runner.agents()).toEqual(['intake'])
  })

  test('an agent failure stalls the job at its stage with the error', async () => {
    const { env, orch } = await factory({ ...happy, 'spec-writer': () => 'rate limited' })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('spec')
    expect(orch.errors.get('001-issue-1')).toContain('spec-writer failed: rate limited')
  })

  test('retry restarts a stalled job from its stage', async () => {
    let fail = true
    const { env, runner, orch } = await factory({ ...happy, 'spec-writer': t => fail ? 'rate limited' : write(t, 'spec.md', '# s\n') })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    fail = false
    orch.retry('001-issue-1')
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('merged')
    expect(runner.agents().filter(a => a === 'intake')).toHaveLength(1)
    expect(orch.errors.size).toBe(0)
  })

  test('a BLOCKED build escalates', async () => {
    const { env, orch } = await factory({ ...happy, builder: t => write(t, 'build.md', 'STATUS: BLOCKED\n\n## Blocked\nNeeds a decision.\n') })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('needs-human')
  })

  test('UI surfaces route ux and ui reviewers in parallel with ports', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      'intake': t => write(t, 'intake.md', 'DECISION: ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: no\n'),
      'reviewer-ux': t => write(t, `round-${t.round}/review-ux.md`, 'VERDICT: PASS\n'),
      'reviewer-ui': t => write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const reviews = runner.tasks.filter(t => t.agent.startsWith('reviewer-'))
    expect(reviews.map(t => [t.agent, t.model]).sort()).toEqual([['reviewer-code', 'sonnet'], ['reviewer-ui', 'haiku'], ['reviewer-ux', 'sonnet']])
    expect(reviews.find(t => t.agent === 'reviewer-ux')!.message).toContain('Port: 5111.')
    expect(runner.maxActive).toBe(3)
  })

  test('each review verdict reaches the board as soon as its reviewer finishes', async () => {
    const { env, orch } = await factory({
      ...happy,
      'intake': t => write(t, 'intake.md', 'DECISION: ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: no\n'),
      'reviewer-ux': async (t) => {
        await Bun.sleep(80)
        await write(t, `round-${t.round}/review-ux.md`, 'VERDICT: PASS\n')
      },
      'reviewer-ui': async (t) => {
        await Bun.sleep(80)
        await write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
      }
    })
    const seen: Array<Record<string, string>> = []
    orch.on('event', (e: FactoryEvent) => {
      if (e.type === 'job' && e.job.stage === 'review') seen.push({ ...e.job.reviews })
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect(seen).toContainEqual({ code: 'PASS', ux: 'pending', ui: 'pending' })
  })

  test('concurrency caps running jobs and the drain finishes them all', async () => {
    const { env, runner, orch } = await factory({ ...happy }, { concurrency: 2 })
    for (const n of [1, 2, 3]) env.github.addIssue({ number: n })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list()).map(j => j.stage)).toEqual(['merged', 'merged', 'merged'])
    expect(runner.maxActive).toBeLessThanOrEqual(2)
  })

  test('feedback on an escalated job runs another round', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      approver: (t, n) => write(t, 'decision.md', n === 1 ? 'ESCALATE\n\n## For the human\nPick a colour.\n' : 'APPROVE\n')
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('needs-human')
    await orch.feedback('001-issue-1', 'Blue.')
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('merged')
    expect(runner.tasks.filter(t => t.agent === 'builder').at(-1)!.message).toContain('The user gave feedback: read feedback-1.md')
    expect(existsSync(join(env.paths.jobs, '001-issue-1', 'feedback-1.md'))).toBe(true)
  })
})
