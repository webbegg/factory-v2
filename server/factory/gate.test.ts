import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultConfig } from './config'
import { globToRegExp } from './gate'
import type { StopCheckRecord } from './gate'
import type { CommitCheck } from './ports'
import { route } from './route'
import { makeEnv, seed } from './testing'
import type { TestEnv } from './testing'
import type { Job } from './types'

const ID = '001-add-a-thing'
const SHA = 'a'.repeat(40)
const AGENTS = { reviewers: { code: 'haiku' } }

/** checks.sh as committed on origin/<base>, which is the copy the gate runs */
function withChecks(env: TestEnv, script: string) {
  env.git.committed.set('.factory/checks.sh', `set -euo pipefail\n${script}\n`)
}

async function gateJob(env: TestEnv, fields = {}) {
  const job = await seed(env, { stage: 'gate', round: 1, pr: 9, agents: AGENTS, ...fields })
  await mkdir(job.worktree, { recursive: true })
  return job
}

const BASE = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)

/** a file outside the worktree that checks.sh appends to on every run */
const counter = (env: TestEnv) => join(env.paths.repo, 'checks-runs')
async function runs(env: TestEnv) {
  const file = Bun.file(counter(env))
  return await file.exists() ? (await file.text()).trim().split('\n').length : 0
}

/** what the orchestrator records when the builder's stop check runs */
async function stopCheck(env: TestEnv, round = 1): Promise<StopCheckRecord> {
  const before = env.git.headSha
  const cleanBefore = env.git.clean
  const checks = await env.gate.runChecks(join(env.paths.worktrees, ID))
  return { ...checks, round, before, cleanBefore, after: env.git.headSha }
}

/** checks.md as an earlier gate run left it */
const passed = (base: string | null = BASE, verdict = 'PASS') =>
  `GATE: ${verdict}\nCOMMIT: ${SHA}\n${base ? `BASE: ${base}\n` : ''}\n## Summary\n- ok\n`

describe('globToRegExp', () => {
  test('* matches across /, ? one char, everything else literal', () => {
    expect(globToRegExp('.factory/*').test('.factory/a/b.sh')).toBe(true)
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
    expect(globToRegExp('a.b').test('aXb')).toBe(false)
    expect(globToRegExp('.factory/checks.sh').test('x/.factory/checks.sh')).toBe(false)
  })
})

describe('gate', () => {
  test('PASS writes checks.md for HEAD with the log tail, run in the worktree', async () => {
    const env = await makeEnv()
    await withChecks(env, 'echo "checking in $(basename "$PWD")"')
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result.verdict).toBe('PASS')
    const md = await env.store.read(ID, 'round-1/checks.md') ?? ''
    expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${SHA}\n\n## Summary\n`)
    expect(md).toContain('checking in 001-add-a-thing')
    expect(await env.store.read(ID, 'round-1/checks.log')).toBe('checking in 001-add-a-thing\n')
    // the machine now accepts the move
    expect((await env.machine.advance(ID, 'review')).stage).toBe('review')
  })

  test('the gate runs checks.sh from origin/<base>, not the main checkout\'s working copy', async () => {
    const env = await makeEnv()
    withChecks(env, 'true')
    await mkdir(env.paths.factory, { recursive: true })
    await writeFile(join(env.paths.factory, 'checks.sh'), 'exit 1\n')
    await gateJob(env)
    expect((await env.gate.run(ID)).verdict).toBe('PASS')
    // fetched right before reading, so a moved local origin/main can't stand in for the real one (verify B3)
    const calls = env.git.calls.map(c => c.slice(0, 3).join(' '))
    // the full ref: a tag or branch named origin/main would win over the short name (verify run 2, B4)
    const show = calls.indexOf(`show ${env.paths.repo} refs/remotes/origin/main`)
    expect(calls[show - 1]).toBe(`fetch ${env.paths.repo} main`)
  })

  test('checks.sh missing on origin/<base> fails the gate and says so', async () => {
    const env = await makeEnv()
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result.verdict).toBe('FAIL')
    expect(await env.store.read(ID, 'round-1/checks.log')).toContain('.factory/checks.sh isn\'t committed on origin/main')
  })

  test('checks.sh runs without the factory\'s secrets in its environment', async () => {
    const env = await makeEnv()
    process.env.FACTORY_TEST_TOKEN = 'leak'
    try {
      withChecks(env, 'echo "token=${FACTORY_TEST_TOKEN:-none} ci=$CI"')
      await gateJob(env)
      await env.gate.run(ID)
      expect(await env.store.read(ID, 'round-1/checks.log')).toBe('token=none ci=1\n')
    } finally {
      delete process.env.FACTORY_TEST_TOKEN
    }
  })

  test('checks.sh that runs past limits.checksMinutes fails the gate', async () => {
    const env = await makeEnv({ limits: { ...defaultConfig().limits, checksMinutes: 0.005 } })
    withChecks(env, 'sleep 30')
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result).toMatchObject({ verdict: 'FAIL', code: 124 })
    expect(await env.store.read(ID, 'round-1/checks.log')).toContain('timed out after 0.3s')
  }, 20_000)

  test('a failing checks.sh fails the gate with its exit code', async () => {
    const env = await makeEnv()
    await withChecks(env, 'echo boom >&2; exit 3')
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result).toMatchObject({ verdict: 'FAIL', code: 3 })
    expect(await env.store.read(ID, 'round-1/checks.md')).toContain('failed with exit 3')
  })

  test('adding, modifying or deleting a protected file fails', async () => {
    const env = await makeEnv({ protectedPaths: ['.github/*', 'src/locked.ts'] })
    await withChecks(env, 'true')
    await gateJob(env)
    env.git.changed = [{ status: 'M', path: 'src/x.ts' }]
    expect((await env.gate.run(ID)).verdict).toBe('PASS')
    env.git.changed.push({ status: 'A', path: '.github/workflows/x.yml' }, { status: 'D', path: 'src/locked.ts' })
    const result = await env.gate.run(ID)
    expect(result).toMatchObject({ verdict: 'FAIL', code: 0, protectedChanges: ['A .github/workflows/x.yml', 'D src/locked.ts'] })
  })

  test('.factory/ is protected whatever the config says', async () => {
    const env = await makeEnv({ protectedPaths: [] })
    await withChecks(env, 'true')
    await gateJob(env)
    env.git.changed = [{ status: 'A', path: '.factory/agents/approver.md' }]
    expect(await env.gate.run(ID)).toMatchObject({ verdict: 'FAIL', protectedChanges: ['A .factory/agents/approver.md'] })
  })

  test('the defaults protect CI config', () => {
    expect(defaultConfig().protectedPaths).toContain('.github/*')
  })

  test('--merge writes merge-checks.md and leaves checks.md alone', async () => {
    const env = await makeEnv()
    await withChecks(env, 'true')
    await gateJob(env)
    await env.gate.run(ID, { merge: true })
    expect(await env.store.read(ID, 'round-1/merge-checks.md')).toContain('synced with the latest main')
    expect(await env.store.read(ID, 'round-1/checks.md')).toBeNull()
  })

  test('BASE is the origin/<base> sha the checks ran against, for checks.md and merge-checks.md', async () => {
    const env = await makeEnv()
    withChecks(env, 'true')
    env.git.remoteHeads.set('main', BASE)
    await gateJob(env)
    expect(await env.gate.run(ID)).toMatchObject({ verdict: 'PASS', base: BASE, reused: undefined })
    expect(await env.store.read(ID, 'round-1/checks.md')).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n`)
    await env.gate.run(ID, { merge: true })
    expect(await env.store.read(ID, 'round-1/merge-checks.md')).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n`)
  })

  test('an unreadable base sha is written as BASE: unknown and never reused', async () => {
    const env = await makeEnv()
    withChecks(env, `echo run >> ${counter(env)}`)
    env.git.remoteHeads.set('main', null)
    await gateJob(env)
    await env.gate.run(ID)
    expect(await env.store.read(ID, 'round-1/checks.md')).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: unknown\n`)
    expect(await env.gate.run(ID)).toMatchObject({ verdict: 'PASS', reused: undefined })
    expect(await runs(env)).toBe(2)
  })

  test('refuses a job without a build round', async () => {
    const env = await makeEnv()
    await withChecks(env, 'true')
    await gateJob(env, { round: 0 })
    await expect(env.gate.run(ID)).rejects.toThrow('hasn\'t started a build round')
  })
})

describe('gate reuse', () => {
  async function setup() {
    const env = await makeEnv()
    withChecks(env, `echo "run $(basename "$PWD")" >> ${counter(env)}; echo stop-check-output`)
    env.git.remoteHeads.set('main', BASE)
    await gateJob(env)
    return env
  }

  test('a passing stop check on the same HEAD and base sha stands in for checks.sh', async () => {
    const env = await setup()
    const record = await stopCheck(env)
    const result = await env.gate.run(ID, { stopCheck: record })
    expect(await runs(env)).toBe(1)
    expect(result).toMatchObject({ verdict: 'PASS', code: 0, commit: SHA, base: BASE, reused: 'the builder\'s stop check' })
    expect(result.line).toContain('reused the builder\'s stop check')
    expect(result.line).not.toContain('checks.sh exit')
    const md = await env.store.read(ID, 'round-1/checks.md') ?? ''
    expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n\n## Summary\n`)
    expect(md).toContain(`- checks.sh not re-run: reused the builder's stop check (passed on aaaaaaa against main@bbbbbbb)\n`)
    expect(md).toContain('## checks.sh\nchecks.sh not re-run: reused the builder\'s stop check')
    expect(await env.store.read(ID, 'round-1/checks.log')).toBe('stop-check-output\n')
    // the machine accepts the reused pass like any other
    expect((await env.machine.advance(ID, 'review')).stage).toBe('review')
  })

  test('a different base sha at gate time runs checks.sh and records the new BASE', async () => {
    const env = await setup()
    const record = await stopCheck(env)
    env.git.remoteHeads.set('main', OTHER)
    const result = await env.gate.run(ID, { stopCheck: record })
    expect(await runs(env)).toBe(2)
    expect(result).toMatchObject({ verdict: 'PASS', base: OTHER, reused: undefined })
    const md = await env.store.read(ID, 'round-1/checks.md') ?? ''
    expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${OTHER}\n`)
    expect(md).not.toContain('not re-run')
  })

  test('a different HEAD at gate time runs checks.sh', async () => {
    const env = await setup()
    const record = await stopCheck(env)
    env.git.headSha = OTHER
    expect(await env.gate.run(ID, { stopCheck: record })).toMatchObject({ commit: OTHER, reused: undefined })
    expect(await runs(env)).toBe(2)
  })

  test('a commit made while the stop check ran is not covered by it', async () => {
    const env = await setup()
    const record = { ...await stopCheck(env), before: OTHER }
    expect((await env.gate.run(ID, { stopCheck: record })).reused).toBeUndefined()
    expect(await runs(env)).toBe(2)
  })

  test('a failed stop check, a dirty worktree, another round or no stop check means checks.sh runs', async () => {
    const cases: Array<[string, (r: StopCheckRecord, env: TestEnv) => StopCheckRecord | undefined]> = [
      ['failed', r => ({ ...r, code: 1 })],
      ['dirty at the stop check', r => ({ ...r, cleanBefore: false })],
      ['dirty at the gate', (r, env) => {
        env.git.clean = false
        return r
      }],
      ['another round', r => ({ ...r, round: 2 })],
      ['base unknown', r => ({ ...r, base: null })],
      ['none', () => undefined]
    ]
    for (const [why, change] of cases) {
      const env = await setup()
      const record = change(await stopCheck(env), env)
      const result = await env.gate.run(ID, { stopCheck: record })
      expect([why, result.reused, await runs(env)]).toEqual([why, undefined, 2])
      expect(await env.store.read(ID, 'round-1/checks.md')).not.toContain('not re-run')
    }
  }, 20_000)

  test('a restarted gate reuses its own PASS checks.md for the same HEAD and BASE and keeps its log', async () => {
    const env = await setup()
    await env.gate.run(ID)
    const log = await env.store.read(ID, 'round-1/checks.log')
    const result = await env.gate.run(ID)
    expect(await runs(env)).toBe(1)
    expect(result).toMatchObject({ verdict: 'PASS', reused: 'round-1/checks.md' })
    const md = await env.store.read(ID, 'round-1/checks.md') ?? ''
    expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n`)
    expect(md).toContain('checks.sh not re-run: reused round-1/checks.md (passed on aaaaaaa against main@bbbbbbb)')
    expect(await env.store.read(ID, 'round-1/checks.log')).toBe(log)
  })

  test('a FAIL checks.md, or one with a missing or different BASE, means checks.sh runs', async () => {
    for (const md of [passed(BASE, 'FAIL'), passed(null), passed(OTHER), passed('unknown')]) {
      const env = await setup()
      await env.store.write(ID, 'round-1/checks.md', md)
      expect((await env.gate.run(ID)).reused).toBeUndefined()
      expect(await runs(env)).toBe(1)
    }
  })

  test('a protected-path change fails the gate even when a pass would be reused', async () => {
    const env = await setup()
    const record = await stopCheck(env)
    env.git.changed = [{ status: 'M', path: '.github/workflows/ci.yml' }]
    const result = await env.gate.run(ID, { stopCheck: record })
    expect(result).toMatchObject({ verdict: 'FAIL', protectedChanges: ['M .github/workflows/ci.yml'] })
    expect(await env.store.read(ID, 'round-1/checks.md')).toContain('## Protected paths\n- M .github/workflows/ci.yml')
  })

  test('the merge gate ignores the stop check', async () => {
    const env = await setup()
    const record = await stopCheck(env)
    expect((await env.gate.run(ID, { merge: true, stopCheck: record, headUnchanged: true })).reused).toBeUndefined()
    expect(await runs(env)).toBe(2)
  })
})

describe('route', () => {
  const intake = (risk: string, surfaces: string[]) => ({ decision: 'ACCEPT', rescoped: false, risk, surfaces }) as never

  test('risk picks the code reviewer; surfaces add lenses', async () => {
    const env = await makeEnv()
    expect(route(intake('low', []), env.config)).toEqual({ reviewers: { code: 'haiku' } })
    expect(route(intake('high', ['ui', 'security']), env.config)).toEqual({
      reviewers: { code: 'sonnet', ux: 'sonnet', ui: 'sonnet', security: 'opus' }
    })
  })

  test('unknown risk or surface is an error, not a silent default', async () => {
    const env = await makeEnv()
    expect(() => route(intake('extreme', []), env.config)).toThrow('risk \'extreme\' isn\'t in config routing (low, medium, high)')
    expect(() => route(intake('low', ['perf']), env.config)).toThrow('surface \'perf\' isn\'t in config surfaceReviewers (ui, security)')
  })
})

describe('merge', () => {
  async function approved(env: TestEnv, fields: Partial<Job> = {}) {
    await withChecks(env, 'true')
    const job = await seed(env, { stage: 'approve', round: 1, pr: 9, agents: AGENTS, ...fields }, {
      'decision.md': 'APPROVE\n\n## Why\nfine\n'
    })
    await mkdir(job.worktree, { recursive: true })
    return job
  }

  test('syncs with the base, gates again, pushes, merges the PR and finishes', async () => {
    const env = await makeEnv({ mergeMethod: 'squash' })
    const job = await approved(env)
    env.github.drafts.add(9)
    const done = await env.merger.merge(ID)
    expect(done.stage).toBe('merged')
    expect(env.git.calls).toContainEqual(['merge', job.worktree, 'origin/main'])
    expect(env.git.calls).toContainEqual(['push', job.worktree, job.branch])
    expect(env.github.calls).toContainEqual(['ready', 9])
    expect(env.github.calls).toContainEqual(['merge', 9, 'squash', 'a'.repeat(40)])
    expect(await env.store.read(ID, 'round-1/merge-checks.md')).toStartWith('GATE: PASS')
  })

  test('a conflict with the base goes back to the builder while rounds remain', async () => {
    const env = await makeEnv()
    await approved(env)
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    const job = await env.merger.merge(ID)
    expect(job).toMatchObject({ stage: 'build', round: 2, roundReason: 'sync' })
    expect(await env.store.read(ID, 'round-1/sync.md')).toContain('CONFLICT (content): a.txt')
    expect(await env.store.read(ID, 'decision.md')).toStartWith('APPROVE')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
  })

  test('a conflict with the base on the last round escalates to a human', async () => {
    const env = await makeEnv()
    await approved(env, { roundLimit: 1 })
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    const job = await env.merger.merge(ID)
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('The branch conflicts with main:\n\n```\nCONFLICT (content): a.txt\n```')
    expect(await env.store.read(ID, 'round-1/sync.md')).toContain('CONFLICT (content): a.txt')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
  })

  test('a failing gate after the sync escalates and does not merge', async () => {
    const env = await makeEnv()
    await approved(env)
    await withChecks(env, 'exit 1')
    const job = await env.merger.merge(ID)
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('The gate failed after syncing with main')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
  })

  test('a refused gh pr merge escalates with the error', async () => {
    const env = await makeEnv()
    await approved(env)
    env.github.mergeError = 'branch protection: 1 review required'
    const job = await env.merger.merge(ID)
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('branch protection: 1 review required')
  })

  test('a PR already merged by a person just finishes the job', async () => {
    const env = await makeEnv()
    await approved(env)
    env.github.prStates.set(9, 'MERGED')
    expect((await env.merger.merge(ID)).stage).toBe('merged')
    expect(env.git.calls.map(c => c[0])).toEqual(['removeWorktree', 'deleteBranch'])
  })

  test('merges run one at a time, so each is gated against the base the previous one left', async () => {
    const env = await makeEnv()
    const trace = join(env.paths.repo, 'trace')
    await withChecks(env, `echo "start $(basename "$PWD")" >> ${trace}; sleep 0.2; echo "end $(basename "$PWD")" >> ${trace}`)
    for (const [id, pr] of [['001-a', 9], ['002-b', 10]] as const) {
      const job = await seed(env, { id, issue: pr, stage: 'approve', round: 1, pr, agents: AGENTS }, { 'decision.md': 'APPROVE\n' })
      await mkdir(job.worktree, { recursive: true })
    }
    await Promise.all([env.merger.merge('001-a'), env.merger.merge('002-b')])
    const lines = (await Bun.file(trace).text()).trim().split('\n')
    expect(lines).toHaveLength(4)
    // no second start before the first one's end
    expect(lines[1]).toBe(lines[0]!.replace('start', 'end'))
    expect(lines[3]).toBe(lines[2]!.replace('start', 'end'))
  }, 30_000) // four real bash runs with sleeps; busy hosts exceed the 5s default

  test('an aborted merge stops after the gate and doesn\'t merge (review R4-001)', async () => {
    const env = await makeEnv()
    await approved(env)
    withChecks(env, 'sleep 30')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    await expect(env.merger.merge(ID, controller.signal)).rejects.toThrow('merge cancelled')
    expect(env.github.calls.some(c => c[0] === 'merge')).toBe(false)
    expect((await env.store.load(ID)).stage).toBe('merging')
  }, 20_000)

  describe('reusing the round gate', () => {
    async function gated(env: TestEnv, base = BASE) {
      await approved(env)
      withChecks(env, `echo run >> ${counter(env)}`)
      env.git.remoteHeads.set('main', BASE)
      await env.store.write(ID, 'round-1/checks.md', passed(base))
    }

    test('a sync that leaves HEAD unchanged reuses round-N/checks.md and merges that HEAD', async () => {
      const env = await makeEnv()
      await gated(env)
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(await runs(env)).toBe(0)
      const md = await env.store.read(ID, 'round-1/merge-checks.md') ?? ''
      expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n`)
      expect(md).toContain('checks.sh not re-run: reused round-1/checks.md (passed on aaaaaaa against main@bbbbbbb)')
      expect(await env.store.read(ID, 'round-1/merge-checks.log')).toBe('reused round-1/checks.log\n')
      expect(env.github.calls).toContainEqual(['merge', 9, 'merge', SHA])
    })

    test('a sync that moves HEAD runs checks.sh and merges the new HEAD', async () => {
      const env = await makeEnv()
      await gated(env)
      const merge = env.git.merge.bind(env.git)
      env.git.merge = async (cwd, ref) => {
        env.git.headSha = OTHER
        return merge(cwd, ref)
      }
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(await runs(env)).toBe(1)
      expect(await env.store.read(ID, 'round-1/merge-checks.md')).not.toContain('not re-run')
      expect(env.github.calls).toContainEqual(['merge', 9, 'merge', OTHER])
    })

    test('a base sha that moved since checks.md runs checks.sh', async () => {
      const env = await makeEnv()
      await gated(env, OTHER)
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(await runs(env)).toBe(1)
      expect(await env.store.read(ID, 'round-1/merge-checks.md')).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\nBASE: ${BASE}\n`)
    })
  })

  describe('waiting for GitHub CI', () => {
    const check = (name: string, state: CommitCheck['state'], url: string | null = null): CommitCheck => ({ name, state, url })
    const merges = (env: TestEnv) => env.github.calls.filter(c => c[0] === 'merge')

    test('pending then all passed merges the gated commit, after asking for its checks', async () => {
      const env = await makeEnv()
      await approved(env)
      env.github.checkResponses = [[check('build', 'pending')], [check('build', 'success'), check('lint', 'success')]]
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      const names = env.github.calls.map(c => c[0])
      expect(env.github.calls).toContainEqual(['commitChecks', SHA])
      expect(names.lastIndexOf('commitChecks')).toBeLessThan(names.indexOf('merge'))
      expect(names.filter(n => n === 'commitChecks')).toHaveLength(2)
      expect(env.clock.ms).toBe(15_000)
      expect(env.merger.ciWaiting.size).toBe(0)
    })

    test('a failed check escalates with its name and URL and does not merge', async () => {
      const env = await makeEnv()
      await approved(env)
      env.github.checkResponses = [[check('lint', 'success'), check('build', 'failure', 'https://github.com/o/r/actions/runs/1')]]
      const job = await env.merger.merge(ID)
      expect(job.stage).toBe('needs-human')
      expect(merges(env)).toHaveLength(0)
      const decision = await env.store.read(ID, 'decision.md') ?? ''
      expect(decision).toStartWith('ESCALATE')
      expect(decision).toContain('GitHub CI failed on aaaaaaa')
      expect(decision).toContain('- build: https://github.com/o/r/actions/runs/1')
      expect(decision).not.toContain('lint')
    })

    test('no checks within startMinutes merges with a note after the gate\'s content', async () => {
      const env = await makeEnv()
      await approved(env)
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(env.clock.ms).toBe(2 * 60_000)
      const md = await env.store.read(ID, 'round-1/merge-checks.md') ?? ''
      expect(md).toStartWith('GATE: PASS')
      expect(md).toContain('## GitHub CI\nNo check runs or statuses appeared on aaaaaaa within 2 minutes, so the merge went ahead.')
      expect(md.indexOf('## GitHub CI')).toBeGreaterThan(md.indexOf('## checks.sh'))
    })

    test('a check that appears by startMinutes, still pending, keeps the wait going past it', async () => {
      const env = await makeEnv()
      await approved(env)
      // polls at 0, 15 … 105 s find nothing; the one at 120 s finds e2e running
      env.github.checkResponses = [...Array(8).fill([]), [check('e2e', 'pending')], [check('e2e', 'success')]]
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(await env.store.read(ID, 'round-1/merge-checks.md')).toContain('Every check on aaaaaaa passed.')
    })

    test('a check still pending after ci.minutes escalates naming it', async () => {
      const env = await makeEnv()
      await approved(env)
      env.github.checkResponses = [[check('e2e', 'pending'), check('lint', 'success')]]
      const job = await env.merger.merge(ID)
      expect(job.stage).toBe('needs-human')
      expect(env.clock.ms).toBe(30 * 60_000)
      expect(merges(env)).toHaveLength(0)
      const decision = await env.store.read(ID, 'decision.md') ?? ''
      expect(decision).toContain('GitHub CI was still running on aaaaaaa after 30 minutes:\n\n- e2e')
      expect(decision).not.toContain('lint')
    })

    test('an abort during the wait leaves the job in merging and does not merge', async () => {
      const env = await makeEnv()
      await approved(env)
      const controller = new AbortController()
      env.github.checkResponses = [[check('e2e', 'pending')]]
      const commitChecks = env.github.commitChecks.bind(env.github)
      let polls = 0
      env.github.commitChecks = async (s) => {
        if (++polls === 3) controller.abort()
        return commitChecks(s)
      }
      const seen: Array<[string, boolean]> = []
      env.merger.onCiWait = (jobId, waiting) => seen.push([jobId, waiting])
      await expect(env.merger.merge(ID, controller.signal)).rejects.toThrow('merge cancelled')
      expect(merges(env)).toHaveLength(0)
      expect((await env.store.load(ID)).stage).toBe('merging')
      expect(seen).toEqual([[ID, true], [ID, false]])
      expect(env.merger.ciWaiting.size).toBe(0)
    })

    test('a commitChecks error escalates like a refused merge', async () => {
      const env = await makeEnv()
      await approved(env)
      env.github.commitChecks = async () => {
        throw new Error('gh: HTTP 502')
      }
      const job = await env.merger.merge(ID)
      expect(job.stage).toBe('needs-human')
      expect(await env.store.read(ID, 'decision.md')).toContain('The merge failed:\n\n```\ngh: HTTP 502\n```')
      expect(merges(env)).toHaveLength(0)
    })

    test('ci.wait false merges without asking for checks', async () => {
      const env = await makeEnv({ ci: { wait: false, startMinutes: 2, minutes: 30 } })
      await approved(env)
      expect((await env.merger.merge(ID)).stage).toBe('merged')
      expect(env.github.calls.some(c => c[0] === 'commitChecks')).toBe(false)
      expect(merges(env)).toHaveLength(1)
      expect(await env.store.read(ID, 'round-1/merge-checks.md')).not.toContain('## GitHub CI')
    })

    test('check names and URLs from GitHub cannot add markdown or links to decision.md', async () => {
      const env = await makeEnv()
      await approved(env)
      env.github.checkResponses = [[check('x`\n## Fake\n`y', 'failure', 'javascript:alert(1)'), check('z'.repeat(500), 'failure')]]
      expect((await env.merger.merge(ID)).stage).toBe('needs-human')
      const decision = await env.store.read(ID, 'decision.md') ?? ''
      expect(decision.split('\n').some(l => l.startsWith('## Fake'))).toBe(false)
      expect(decision).not.toContain('`')
      expect(decision).not.toContain('javascript:')
      expect(decision).toContain('- x ## Fake y\n')
      expect(decision).toContain(`- ${'z'.repeat(200)}\n`)
      expect(decision).not.toContain('z'.repeat(201))
    })
  })

  test('only an approved job merges', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: AGENTS })
    await expect(env.merger.merge(ID)).rejects.toThrow('is in review, not approve or merging')
  })
})
