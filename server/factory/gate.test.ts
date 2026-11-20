import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { globToRegExp } from './gate'
import { route } from './route'
import { makeEnv, seed } from './testing'
import type { TestEnv } from './testing'

const ID = '001-add-a-thing'
const SHA = 'a'.repeat(40)
const AGENTS = { reviewers: { code: 'haiku' } }

async function withChecks(env: TestEnv, script: string) {
  await mkdir(env.paths.factory, { recursive: true })
  await writeFile(join(env.paths.factory, 'checks.sh'), `set -euo pipefail\n${script}\n`)
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

  test('a failing checks.sh fails the gate with its exit code', async () => {
    const env = await makeEnv()
    await withChecks(env, 'echo boom >&2; exit 3')
    await gateJob(env)
    const result = await env.gate.run(ID)
    expect(result).toMatchObject({ verdict: 'FAIL', code: 3 })
    expect(await env.store.read(ID, 'round-1/checks.md')).toContain('failed with exit 3')
  })

  test('modifying or deleting a protected file fails; adding one does not', async () => {
    const env = await makeEnv()
    await withChecks(env, 'true')
    await gateJob(env)
    env.git.changed = [{ status: 'A', path: '.factory/new.md' }, { status: 'M', path: 'src/x.ts' }]
    expect((await env.gate.run(ID)).verdict).toBe('PASS')
    env.git.changed.push({ status: 'D', path: '.factory/checks.sh' })
    const result = await env.gate.run(ID)
    expect(result).toMatchObject({ verdict: 'FAIL', code: 0, protectedChanges: ['D .factory/checks.sh'] })
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
  async function approved(env: TestEnv) {
    await withChecks(env, 'true')
    const job = await seed(env, { stage: 'approve', round: 1, pr: 9, agents: AGENTS }, {
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
    expect(env.github.calls).toContainEqual(['merge', 9, 'squash'])
    expect(await env.store.read(ID, 'round-1/merge-checks.md')).toStartWith('GATE: PASS')
  })

  test('a conflict with the base escalates to a human', async () => {
    const env = await makeEnv()
    await approved(env)
    env.git.mergeResult = { ok: false, output: 'CONFLICT (content): a.txt' }
    const job = await env.merger.merge(ID)
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('The branch conflicts with main:\n\n```\nCONFLICT (content): a.txt\n```')
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

  test('only an approved job merges', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: AGENTS })
    await expect(env.merger.merge(ID)).rejects.toThrow('is in review, not approve or merging')
  })
})
