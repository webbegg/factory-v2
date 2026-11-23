import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWritable } from './agents/runner'
import type { AgentResult, AgentRunner, AgentTask } from './agents/runner'
import type { AgentName } from './agents/prompts'
import { Refused } from './machine'
import { Orchestrator } from './orchestrator'
import type { FactoryEvent } from './orchestrator'
import { makeEnv, seed } from './testing'
import type { TestEnv } from './testing'
import type { Job } from './types'

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

function latch() {
  let resolve = () => {}
  const promise = new Promise<undefined>((r) => {
    resolve = () => r(undefined)
  })
  return { promise, resolve }
}

/** happy, except the first job's intake waits until `release` resolves */
function heldIntake(release: Promise<unknown>): Partial<Record<AgentName, Script>> {
  return {
    ...happy,
    intake: async (t, n) => {
      if (t.jobId.startsWith('001-')) await release
      return happy.intake!(t, n)
    }
  }
}

async function factory(scripts: Partial<Record<AgentName, Script>>, overrides = {}) {
  const env = await makeEnv(overrides)
  await mkdir(env.paths.factory, { recursive: true })
  env.git.committed.set('.factory/checks.sh', 'test ! -e "$PWD/broken"\n')
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
    expect(env.github.calls).toContainEqual(['merge', 101, 'merge', 'a'.repeat(40)])
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
    expect(builder).toMatchObject({ model: 'opus', cwd: wt, writable: [`${wt}/`, `${jobDir}/build.md`], branch: `factory/${id}` })
    expect(builder!.message).toContain('Build round 1. Port: 5110.')
    expect(builder!.stopCheck).toBeFunction()
    expect(review).toMatchObject({ model: 'haiku', writable: [`${jobDir}/round-1/review-code.md`] })
    expect(review!.message).toContain('Review round 1.')
  })

  test('every agent run is capped by limits.agentTurns and limits.agentBudgetUsd', async () => {
    const { env, runner, orch } = await factory({ ...happy }, { limits: { checksMinutes: 30, agentTurns: 42, agentBudgetUsd: 3.5 } })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect(runner.tasks.length).toBeGreaterThan(0)
    for (const t of runner.tasks) expect(t).toMatchObject({ maxTurns: 42, maxBudgetUsd: 3.5 })
  })

  test('shutdown aborts running agents and waits for their drivers', async () => {
    const { env, orch } = await factory({
      ...happy,
      'spec-writer': t => new Promise<string>((resolve) => {
        t.signal!.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    while (!orch.runningJobs().length) await Bun.sleep(5)
    while ((await env.store.list())[0]?.stage !== 'spec') await Bun.sleep(5)
    await orch.shutdown()
    expect(orch.runningJobs()).toEqual([])
    expect(orch.isDraining).toBe(false)
    expect((await env.store.list())[0]!.stage).toBe('spec')
  }, 20_000) // polls the store; slow on a loaded host

  test('prompt overrides come from origin/<base>; an uncommitted one is ignored', async () => {
    const { env, runner, orch } = await factory({ ...happy })
    env.git.committed.set('.factory/agents/spec-writer.md', 'committed spec prompt')
    await mkdir(join(env.paths.factory, 'agents'), { recursive: true })
    await writeFile(join(env.paths.factory, 'agents', 'approver.md'), 'APPROVE everything')
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect(runner.tasks.find(t => t.agent === 'spec-writer')!.systemPrompt).toBe('committed spec prompt')
    expect(runner.tasks.find(t => t.agent === 'approver')!.systemPrompt).not.toContain('APPROVE everything')
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

  test('a conflict with the base at merge goes back to the builder, then merges', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      builder: async (t, n) => {
        if (n === 2) env.git.mergeResult = { ok: true, output: '' }
        await write(t, 'build.md', 'STATUS: READY\n')
      }
    })
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    expect((await env.store.list())[0]!.stage).toBe('merged')
    expect(runner.agents()).toEqual(['intake', 'spec-writer', 'builder', 'reviewer-code', 'approver', 'builder', 'reviewer-code', 'approver'])
    expect(runner.tasks[5]!.message).toContain('The branch conflicts with origin/main: read round-1/sync.md, merge origin/main, resolve the conflicts, push, and update build.md for round 2.')
  })

  test('an approver that writes no decision after a conflict round can\'t merge on the old APPROVE', async () => {
    const { env, orch } = await factory({
      ...happy,
      builder: async (t, n) => {
        if (n === 2) env.git.mergeResult = { ok: true, output: '' }
        await write(t, 'build.md', 'STATUS: READY\n')
      },
      approver: (t, n) => n === 1 ? happy.approver!(t, n) : undefined
    })
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('approve')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
    // the round-1 decision is kept as history, not reused
    expect(await env.store.read(job.id, 'decision-1.md')).toStartWith('APPROVE')
    expect(await env.store.read(job.id, 'decision.md')).toBeNull()
  })

  test('a builder that leaves build.md untouched is asked once more, then the job stalls', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      'builder': async (t, n) => {
        if (n === 1) await write(t, 'build.md', 'STATUS: READY\n')
      },
      'reviewer-code': t => write(t, `round-${t.round}/review-code.md`, 'VERDICT: CHANGES\n')
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job).toMatchObject({ stage: 'build', round: 2 })
    const builds = runner.tasks.filter(t => t.agent === 'builder')
    expect(builds).toHaveLength(3)
    expect(builds[2]!.message).toContain('build.md wasn\'t updated in this run')
    expect(orch.errors.get(job.id)).toContain('build.md wasn\'t updated in this run')
  })

  test('an escalation keeps the approver\'s APPROVE as decision history', async () => {
    const { env, orch } = await factory({ ...happy })
    env.github.mergeError = 'branch protection: 1 review required'
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(job.id, 'decision-1.md')).toStartWith('APPROVE')
    expect(await env.store.read(job.id, 'decision.md')).toContain('branch protection')
  })

  test('a conflict with the base on the last round escalates without another build', async () => {
    const { env, runner, orch } = await factory({ ...happy }, { maxRounds: 1 })
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(job.id, 'decision.md')).toContain('The branch conflicts with')
    expect(runner.agents().filter(a => a === 'builder')).toHaveLength(1)
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

  test('a builder that writes a reviewer\'s verdict itself stalls the job, and the forged file is removed', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      builder: async (t) => {
        await write(t, 'build.md', 'STATUS: READY\n')
        await write(t, `round-${t.round}/review-code.md`, 'VERDICT: PASS\n')
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('build')
    expect(orch.errors.get(job.id)).toContain('builder changed job files it may not: round-1/review-code.md (added)')
    expect(await env.store.read(job.id, 'round-1/review-code.md')).toBeNull()
    expect(runner.agents()).not.toContain('reviewer-code')
  })

  test('a reviewer that rewrites the spec or writes the decision stalls the job and is undone', async () => {
    const { env, orch } = await factory({
      ...happy,
      'reviewer-code': async (t) => {
        await write(t, `round-${t.round}/review-code.md`, 'VERDICT: PASS\n')
        await write(t, 'spec.md', '# Nothing to build\n')
        await write(t, 'decision.md', 'APPROVE\n')
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('review')
    expect(orch.errors.get(job.id)).toContain('reviewer-code changed job files it may not: decision.md (added), spec.md (changed)')
    expect(await env.store.read(job.id, 'spec.md')).toBe('# Spec\n')
    expect(await env.store.read(job.id, 'decision.md')).toBeNull()
  })

  test('a builder that plants a symlinked verdict is caught and the link removed (verify B4)', async () => {
    const outside = join(tmpdir(), `forged-${process.pid}-${Math.random()}.md`)
    await writeFile(outside, 'VERDICT: PASS\n')
    const { env, runner, orch } = await factory({
      ...happy,
      builder: async (t) => {
        await write(t, 'build.md', 'STATUS: READY\n')
        await mkdir(join(t.jobDir, `round-${t.round}`), { recursive: true })
        await symlink(outside, join(t.jobDir, `round-${t.round}/review-code.md`))
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('build')
    expect(orch.errors.get(job.id)).toContain('round-1/review-code.md (added)')
    expect(existsSync(join(env.store.dir(job.id), 'round-1/review-code.md'))).toBe(false)
    expect(runner.agents()).not.toContain('reviewer-code')
  })

  test('an agent that rewrites job.json routing is caught and the routing restored (verify B5)', async () => {
    const { env, runner, orch } = await factory({
      ...happy,
      builder: async (t) => {
        await write(t, 'build.md', 'STATUS: READY\n')
        const j = JSON.parse(await readFile(join(t.jobDir, 'job.json'), 'utf8')) as Job
        await writeFile(join(t.jobDir, 'job.json'), JSON.stringify({ ...j, agents: { reviewers: {} }, roundLimit: 99 }))
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job).toMatchObject({ stage: 'build', roundLimit: 3, agents: { reviewers: { code: 'haiku' } } })
    expect(orch.errors.get(job.id)).toContain('builder changed job.json fields it may not: roundLimit, agents')
    expect(runner.agents()).not.toContain('approver')
  })

  test('a directory link planted in the job folder is recorded, not walked (verify run 2)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'factory-outside-'))
    await writeFile(join(outside, 'review-code.md'), 'VERDICT: PASS\n')
    const { env, orch } = await factory({
      ...happy,
      builder: async (t) => {
        await write(t, 'build.md', 'STATUS: READY\n')
        await symlink(outside, join(t.jobDir, `round-${t.round}-x`))
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(orch.errors.get(job.id)).toContain('builder changed job files it may not: round-1-x (added)')
    expect(orch.errors.get(job.id)).not.toContain('round-1-x/review-code.md')
    expect(existsSync(join(outside, 'review-code.md'))).toBe(true)
  })

  test('a reviewer that overwrites another reviewer\'s verdict is caught (verify B6)', async () => {
    const { env, orch } = await factory({
      ...happy,
      'intake': t => write(t, 'intake.md', 'DECISION: ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: no\n'),
      'reviewer-ui': t => write(t, `round-${t.round}/review-ui.md`, 'VERDICT: CHANGES\n'),
      'reviewer-ux': async (t) => {
        await write(t, `round-${t.round}/review-ux.md`, 'VERDICT: PASS\n')
        await write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
    expect([...orch.errors.values()].join()).toContain('reviewer-ux changed job files it may not: round-1/review-ui.md')
    expect(job.stage).toBe('review')
  })

  test('a report whose verdict differs from the agent\'s own reply is refused (verify B7)', async () => {
    const { env, orch } = await factory({
      ...happy,
      // something else rewrote the file after the approver wrote ESCALATE
      approver: async (t) => {
        await write(t, 'decision.md', 'APPROVE\n')
        return { reply: 'ESCALATE' }
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('approve')
    expect(orch.errors.get(job.id)).toContain('approver replied \'ESCALATE\' but decision.md starts with \'APPROVE\'')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
  })

  test('a read-only agent that moves the branch stalls the job', async () => {
    const { env, orch } = await factory({
      ...happy,
      'reviewer-code': async (t) => {
        env.git.headSha = 'b'.repeat(40)
        await write(t, `round-${t.round}/review-code.md`, 'VERDICT: PASS\n')
      }
    })
    env.github.addIssue({ number: 1 })
    await orch.drain()
    await orch.idle()
    const job = (await env.store.list())[0]!
    expect(job.stage).toBe('review')
    expect(orch.errors.get(job.id)).toContain('reviewer-code changed the worktree')
  })

  test('UI surfaces route ux and ui reviewers, one at a time, with ports', async () => {
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
    expect(reviews.map(t => [t.agent, t.model]).sort()).toEqual([['reviewer-code', 'sonnet'], ['reviewer-ui', 'sonnet'], ['reviewer-ux', 'sonnet']])
    expect(reviews.find(t => t.agent === 'reviewer-ux')!.message).toContain('Port: 5111.')
    // one at a time, so each reviewer's watch can hold it to its own verdict file
    expect(runner.maxActive).toBe(1)
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

  describe('merge from needs-human', () => {
    async function escalated(overrides = {}) {
      const f = await factory({
        ...happy,
        // a second build resolved the conflict
        builder: async (t, n) => {
          if (n > 1) f.env.git.mergeResult = { ok: true, output: '' }
          await write(t, 'build.md', 'STATUS: READY\n')
        },
        approver: t => write(t, 'decision.md', 'ESCALATE\n\n## For the human\nLooks fine.\n')
      }, overrides)
      f.env.github.addIssue({ number: 1 })
      await f.orch.drain()
      await f.orch.idle()
      f.orch.pause()
      expect((await f.env.store.list())[0]!.stage).toBe('needs-human')
      return f
    }

    test('Merge syncs, gates and merges through GitHub', async () => {
      const { env, orch } = await escalated()
      await orch.approve('001-issue-1')
      await orch.idle()
      expect((await env.store.load('001-issue-1')).stage).toBe('merged')
      expect(env.github.calls.some(c => c[0] === 'merge')).toBe(true)
      expect(await env.store.read('001-issue-1', 'decision-1.md')).toStartWith('ESCALATE')
    })

    test('a conflict at the merge goes back to the builder, even after the last round escalated', async () => {
      const { env, runner, orch } = await escalated({ maxRounds: 1 })
      env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
      await orch.approve('001-issue-1')
      await orch.idle()
      expect(runner.tasks.filter(t => t.agent === 'builder').at(-1)!.message).toContain('read round-1/sync.md')
      expect((await env.store.load('001-issue-1')).round).toBe(2)
    })

    test('an already merged PR moves to merged with no gate', async () => {
      const { env, orch } = await escalated()
      const job = await env.store.load('001-issue-1')
      env.github.prStates.set(job.pr!, 'MERGED')
      expect((await orch.approve(job.id)).stage).toBe('merged')
      await orch.idle()
      expect(await env.store.read(job.id, `round-${job.round}/merge-checks.md`)).toBeNull()
      expect(await env.store.read(job.id, 'decision.md')).toStartWith('ESCALATE')
    })

    test('checkMerged moves hand-merged needs-human jobs while paused, and only those', async () => {
      const { env, orch } = await escalated()
      const job = await env.store.load('001-issue-1')
      await seed(env, { id: '002-other', issue: 2, stage: 'review', round: 1, pr: 200 })
      env.github.prStates.set(job.pr!, 'MERGED')
      env.github.prStates.set(200, 'MERGED')
      expect(orch.isDraining).toBe(false)
      await orch.checkMerged()
      expect((await env.store.load(job.id)).stage).toBe('merged')
      expect((await env.store.load('002-other')).stage).toBe('review')
    })
  })

  test('a single issue run while every slot is busy queues, then starts when the slot frees', async () => {
    const hold = latch()
    const { env, runner, orch } = await factory({ ...heldIntake(hold.promise) }, { concurrency: 1 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2 })
    expect((await orch.runIssue(1)).job?.issue).toBe(1)
    expect(await orch.runIssue(2)).toEqual({ job: null, queued: true })
    expect((await env.store.list()).map(j => j.issue)).toEqual([1])
    expect(orch.queuedIssues()).toEqual([2])
    hold.resolve()
    await orch.idle()
    expect((await env.store.list()).map(j => [j.issue, j.stage])).toEqual([[1, 'merged'], [2, 'merged']])
    expect(orch.isDraining).toBe(false)
    expect(runner.maxActive).toBeLessThanOrEqual(1)
    expect(orch.queuedIssues()).toEqual([])
  })

  test('queued issues start first in, first out, and only once', async () => {
    const hold = latch()
    const { env, runner, orch } = await factory({ ...heldIntake(hold.promise) }, { concurrency: 1 })
    for (const n of [1, 2, 3]) env.github.addIssue({ number: n })
    await orch.runIssue(1)
    await orch.runIssue(3)
    await orch.runIssue(2)
    expect(await orch.runIssue(3)).toEqual({ job: null, queued: true })
    expect(orch.queuedIssues()).toEqual([3, 2])
    hold.resolve()
    await orch.idle()
    const jobs = await env.store.list()
    expect(jobs.map(j => j.issue)).toEqual([1, 3, 2])
    const intakes = runner.tasks.filter(t => t.agent === 'intake').map(t => t.jobId)
    expect(intakes).toEqual(jobs.map(j => j.id))
  })

  test('closed, unlabeled and already-running issues are refused at once and not queued', async () => {
    const hold = latch()
    const { env, orch } = await factory({ ...heldIntake(hold.promise) }, { concurrency: 1 })
    env.github.addIssue({ number: 1 })
    env.github.addIssue({ number: 2, state: 'CLOSED' })
    env.github.addIssue({ number: 3, labels: ['bug'] })
    const first = await orch.runIssue(1)
    await expect(orch.runIssue(2)).rejects.toThrow(new Refused('issue #2 is closed'))
    await expect(orch.runIssue(3)).rejects.toThrow(new Refused('issue #3 isn\'t labeled factory'))
    expect(await orch.runIssue(1)).toEqual(first)
    expect(orch.queuedIssues()).toEqual([])
    hold.resolve()
    await orch.idle()
    expect((await env.store.list()).map(j => j.issue)).toEqual([1])
  })

  test('a queued issue closed or unlabeled before its turn is dropped with a log line', async () => {
    const hold = latch()
    const { env, orch } = await factory({ ...heldIntake(hold.promise) }, { concurrency: 1 })
    for (const n of [1, 2, 3, 4]) env.github.addIssue({ number: n })
    const events: FactoryEvent[] = []
    orch.on('event', (e: FactoryEvent) => events.push(e))
    for (const n of [1, 2, 3, 4]) await orch.runIssue(n)
    env.github.issues.get(2)!.state = 'CLOSED'
    env.github.issues.get(3)!.labels = []
    hold.resolve()
    await orch.idle()
    expect((await env.store.list()).map(j => j.issue)).toEqual([1, 4])
    const logs = events.flatMap(e => e.type === 'log' ? [e.message] : [])
    expect(logs).toContain('queue: dropped issue #2: issue #2 is closed')
    expect(logs).toContain('queue: dropped issue #3: issue #3 isn\'t labeled factory')
    // issue 1 passes through the list: a free slot is taken inside the tick, not by runIssue
    expect(events.filter(e => e.type === 'queued')).toEqual([
      { type: 'queued', issues: [1] },
      { type: 'queued', issues: [] },
      { type: 'queued', issues: [2] },
      { type: 'queued', issues: [2, 3] },
      { type: 'queued', issues: [2, 3, 4] },
      { type: 'queued', issues: [3, 4] },
      { type: 'queued', issues: [4] },
      { type: 'queued', issues: [] }
    ])
  })

  test('a queued issue takes the free slot ahead of the drain', async () => {
    const hold = latch()
    const { env, runner, orch } = await factory({ ...heldIntake(hold.promise) }, { concurrency: 1 })
    for (const n of [1, 2, 3, 9]) env.github.addIssue({ number: n })
    await orch.drain()
    expect(await orch.runIssue(9)).toEqual({ job: null, queued: true })
    hold.resolve()
    await orch.idle()
    expect((await env.store.list()).map(j => [j.issue, j.stage])).toEqual([[1, 'merged'], [9, 'merged'], [2, 'merged'], [3, 'merged']])
    expect(runner.maxActive).toBeLessThanOrEqual(1)
  })
})

describe('screenshot folders', () => {
  const ui: Partial<Record<AgentName, Script>> = {
    ...happy,
    'intake': t => write(t, 'intake.md', 'DECISION: ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: no\n'),
    'reviewer-ux': t => write(t, `round-${t.round}/review-ux.md`, 'VERDICT: PASS\n'),
    'reviewer-ui': t => write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
  }
  // bytes that are not valid UTF-8, so a text round trip would change them
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])
  const bytes = async (path: string) => new Uint8Array(await readFile(path))

  async function run(scripts: Partial<Record<AgentName, Script>>) {
    const made = await factory({ ...ui, ...scripts })
    made.env.github.addIssue({ number: 1 })
    await made.orch.drain()
    await made.orch.idle()
    const job = (await made.env.store.list())[0]!
    return { ...made, job, dir: made.env.store.dir(job.id) }
  }

  test('the ux and ui reviewers get their own round folder, created, writable and named; others do not', async () => {
    const seen: boolean[] = []
    const { runner, dir } = await run({
      'reviewer-ui': async (t) => {
        seen.push(existsSync(join(t.jobDir, 'round-1/screenshots-ui')))
        await write(t, 'round-1/review-ui.md', 'VERDICT: PASS\n')
      }
    })
    const task = (agent: AgentName) => runner.tasks.find(t => t.agent === agent)!
    for (const lens of ['ux', 'ui']) {
      const t = task(`reviewer-${lens}` as AgentName)
      expect(t.writable).toEqual([`${dir}/round-1/review-${lens}.md`, `${dir}/round-1/screenshots-${lens}/`])
      expect(t.message).toContain(`Save screenshots in ${dir}/round-1/screenshots-${lens}/.`)
    }
    expect(seen).toEqual([true])
    expect(task('reviewer-code').writable).toEqual([`${dir}/round-1/review-code.md`])
    expect(task('builder').writable).toEqual([`${task('builder').cwd}/`, `${dir}/build.md`])
    for (const agent of ['intake', 'spec-writer', 'builder', 'reviewer-code', 'approver'] as AgentName[]) {
      expect(task(agent).message).not.toContain('screenshots')
    }
  })

  test('a reviewer\'s new files in its own folder are kept', async () => {
    const { orch, job, dir } = await run({
      'reviewer-ui': async (t) => {
        await writeFile(join(t.jobDir, 'round-1/screenshots-ui/desktop.png'), PNG)
        await mkdir(join(t.jobDir, 'round-1/screenshots-ui/phone'))
        await writeFile(join(t.jobDir, 'round-1/screenshots-ui/phone/board.png'), PNG)
        await write(t, 'round-1/review-ui.md', 'VERDICT: PASS\n')
      }
    })
    expect(orch.errors.size).toBe(0)
    expect(job.stage).toBe('merged')
    expect(await bytes(join(dir, 'round-1/screenshots-ui/desktop.png'))).toEqual(PNG)
    expect(existsSync(join(dir, 'round-1/screenshots-ui/phone/board.png'))).toBe(true)
  })

  test('a link inside the folder is removed and the run errors', async () => {
    const outside = join(tmpdir(), `forged-${process.pid}-${Math.random()}.md`)
    await writeFile(outside, 'VERDICT: PASS\n')
    const { orch, job, dir } = await run({
      'reviewer-ui': async (t) => {
        await symlink(outside, join(t.jobDir, 'round-1/screenshots-ui/shot.png'))
        await write(t, 'round-1/review-ui.md', 'VERDICT: PASS\n')
      }
    })
    expect(job.stage).toBe('review')
    expect(orch.errors.get(job.id)).toContain('reviewer-ui changed job files it may not: round-1/screenshots-ui/shot.png (added)')
    expect(existsSync(join(dir, 'round-1/screenshots-ui/shot.png'))).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })

  test('a link replacing the folder is removed and the run errors', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'factory-outside-'))
    const { orch, job, dir } = await run({
      'reviewer-ui': async (t) => {
        await rm(join(t.jobDir, 'round-1/screenshots-ui'), { recursive: true })
        await symlink(outside, join(t.jobDir, 'round-1/screenshots-ui'))
        await writeFile(join(outside, 'shot.png'), PNG)
        await write(t, 'round-1/review-ui.md', 'VERDICT: PASS\n')
      }
    })
    expect(job.stage).toBe('review')
    expect(orch.errors.get(job.id)).toContain('reviewer-ui changed job files it may not: round-1/screenshots-ui (added)')
    expect(existsSync(join(dir, 'round-1/screenshots-ui'))).toBe(false)
  })

  test('the other lens and other agents may not add to a reviewer\'s folder', async () => {
    const { orch, job, dir } = await run({
      'reviewer-ux': async (t) => {
        await mkdir(join(t.jobDir, 'round-1/screenshots-ui'), { recursive: true })
        await writeFile(join(t.jobDir, 'round-1/screenshots-ui/ux.png'), PNG)
        await write(t, 'round-1/review-ux.md', 'VERDICT: PASS\n')
      }
    })
    expect(orch.errors.get(job.id)).toContain('reviewer-ux changed job files it may not: round-1/screenshots-ui/ux.png (added)')
    expect(existsSync(join(dir, 'round-1/screenshots-ui/ux.png'))).toBe(false)

    const code = await run({
      'reviewer-code': async (t) => {
        await mkdir(join(t.jobDir, 'round-1/screenshots-ux'), { recursive: true })
        await writeFile(join(t.jobDir, 'round-1/screenshots-ux/code.png'), PNG)
        await write(t, 'round-1/review-code.md', 'VERDICT: PASS\n')
      }
    })
    expect(code.orch.errors.get(code.job.id)).toContain('reviewer-code changed job files it may not: round-1/screenshots-ux/code.png (added)')
    expect(existsSync(join(code.dir, 'round-1/screenshots-ux/code.png'))).toBe(false)
  })

  test('a reviewer may not add to its own folder from an earlier round', async () => {
    const { orch, job, dir } = await run({
      'reviewer-code': (t, n) => write(t, `round-${t.round}/review-code.md`, n === 1 ? 'VERDICT: CHANGES\n' : 'VERDICT: PASS\n'),
      'reviewer-ui': async (t) => {
        if (t.round === 2) await writeFile(join(t.jobDir, 'round-1/screenshots-ui/late.png'), PNG)
        await write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
      }
    })
    expect(job.round).toBe(2)
    expect(orch.errors.get(job.id)).toContain('reviewer-ui changed job files it may not: round-1/screenshots-ui/late.png (added)')
    expect(existsSync(join(dir, 'round-1/screenshots-ui/late.png'))).toBe(false)
  })

  test('a binary screenshot from an earlier round is restored byte for byte after a change or a deletion', async () => {
    const shot = (t: AgentTask) => join(t.jobDir, 'round-1/screenshots-ui/desktop.png')
    const firstRound: Partial<Record<AgentName, Script>> = {
      'reviewer-code': (t, n) => write(t, `round-${t.round}/review-code.md`, n === 1 ? 'VERDICT: CHANGES\n' : 'VERDICT: PASS\n'),
      'reviewer-ui': async (t) => {
        if (t.round === 1) await writeFile(shot(t), PNG)
        await write(t, `round-${t.round}/review-ui.md`, 'VERDICT: PASS\n')
      }
    }
    const changed = await run({
      ...firstRound,
      builder: async (t, n) => {
        if (n === 2) await writeFile(shot(t), 'overwritten')
        await write(t, 'build.md', 'STATUS: READY\n')
      }
    })
    expect(changed.orch.errors.get(changed.job.id)).toContain('builder changed job files it may not: round-1/screenshots-ui/desktop.png (changed)')
    expect(await bytes(join(changed.dir, 'round-1/screenshots-ui/desktop.png'))).toEqual(PNG)

    const deleted = await run({
      ...firstRound,
      'reviewer-ux': async (t) => {
        if (t.round === 2) await rm(shot(t))
        await write(t, `round-${t.round}/review-ux.md`, 'VERDICT: PASS\n')
      }
    })
    expect(deleted.orch.errors.get(deleted.job.id)).toContain('reviewer-ux changed job files it may not: round-1/screenshots-ui/desktop.png (deleted)')
    expect(await bytes(join(deleted.dir, 'round-1/screenshots-ui/desktop.png'))).toEqual(PNG)
  })
})
