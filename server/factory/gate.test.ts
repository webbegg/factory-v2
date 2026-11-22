import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultConfig } from './config'
import { globToRegExp } from './gate'
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
    expect(md).toStartWith(`GATE: PASS\nCOMMIT: ${SHA}\n\n## Summary\n`)
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
    expect(env.git.calls).toContainEqual(['show', env.paths.repo, 'origin/main', '.factory/checks.sh'])
  })

  test('checks.sh missing on origin/<base> fails the gate and says so', async () => {
    const env = await makeEnv()
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result.verdict).toBe('FAIL')
    expect(await env.store.read(ID, 'round-1/checks.log')).toContain('.factory/checks.sh isn\'t committed on origin/main')
  })

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

  test('refuses a job without a build round', async () => {
    const env = await makeEnv()
    await withChecks(env, 'true')
    await gateJob(env, { round: 0 })
    await expect(env.gate.run(ID)).rejects.toThrow('hasn\'t started a build round')
  })
})

describe('route', () => {
  const intake = (risk: string, surfaces: string[]) => ({ decision: 'ACCEPT', rescoped: false, risk, surfaces }) as never

  test('risk picks the code reviewer; surfaces add lenses', async () => {
    const env = await makeEnv()
    expect(route(intake('low', []), env.config)).toEqual({ reviewers: { code: 'haiku' } })
    expect(route(intake('high', ['ui', 'security']), env.config)).toEqual({
      reviewers: { code: 'sonnet', ux: 'sonnet', ui: 'haiku', security: 'opus' }
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
  })

  test('only an approved job merges', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: AGENTS })
    await expect(env.merger.merge(ID)).rejects.toThrow('is in review, not approve or merging')
  })
})
