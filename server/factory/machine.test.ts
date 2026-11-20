import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Refused, TRANSITIONS } from './machine'
import { ACCEPT, makeEnv, seed } from './testing'
import { STAGES } from './types'

const ID = '001-add-a-thing'
const SHA = 'a'.repeat(40)
const REVIEWERS = { reviewers: { code: 'sonnet', ux: 'sonnet' } }
const checks = (verdict: 'PASS' | 'FAIL', commit = SHA) => `GATE: ${verdict}\nCOMMIT: ${commit}\n\n## Summary\n- x\n`

describe('transitions table', () => {
  test('every stage is known and terminal stages have no exits', () => {
    for (const [from, to] of Object.entries(TRANSITIONS)) {
      expect(STAGES).toContain(from as never)
      for (const s of to) expect(STAGES).toContain(s)
    }
    expect(TRANSITIONS.merged).toBeUndefined()
    expect(TRANSITIONS.rejected).toBeUndefined()
  })

  test('an illegal move is refused and nothing is saved', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'spec' }, { 'spec.md': '# s' })
    await expect(env.machine.advance(ID, 'review')).rejects.toThrow(Refused)
    expect((await env.store.load(ID)).stage).toBe('spec')
  })
})

describe('sync', () => {
  test('reads intake header, gate verdict and review verdicts from files', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, agents: { reviewers: { code: 'haiku', ux: 'sonnet', ui: 'haiku' } } }, {
      'intake.md': 'DECISION: ACCEPT\nRISK: high\nSURFACES: ui, security\nRESCOPED: yes\n',
      'round-1/checks.md': checks('PASS'),
      'round-1/review-code.md': 'VERDICT: PASS\n',
      'round-1/review-ux.md': 'looks fine\n'
    })
    const job = await env.machine.sync(await env.store.load(ID))
    expect(job.intake).toEqual({ decision: 'ACCEPT', rescoped: true, risk: 'high', surfaces: ['ui', 'security'] })
    expect(job.gate).toBe('PASS')
    expect(job.reviews).toEqual({ code: 'PASS', ux: 'invalid', ui: 'pending' })
  })

  test('SURFACES: none means no surfaces', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': 'DECISION: REJECT\nRISK: low\nSURFACES: none\nRESCOPED: no\n' })
    const job = await env.machine.sync(await env.store.load(ID))
    expect(job.intake?.surfaces).toEqual([])
  })
})

describe('intake', () => {
  test('ACCEPT → spec needs routed agents', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': ACCEPT })
    await expect(env.machine.advance(ID, 'spec')).rejects.toThrow('route the job first')
  })

  test('ACCEPT → spec comments the decision on the issue and creates the worktree', async () => {
    const env = await makeEnv()
    await seed(env, { agents: REVIEWERS }, { 'intake.md': ACCEPT })
    const job = await env.machine.advance(ID, 'spec')
    expect(job.stage).toBe('spec')
    const [kind, n, text] = env.github.calls[0]!.slice(1) as [string, number, string]
    expect([kind, n]).toEqual(['issue', 1])
    expect(text).toStartWith('### Factory intake: ACCEPT (risk medium, surfaces: ui)')
    expect(text).toContain('## Scope\nBuild it.')
    expect(text).not.toContain('DECISION:')
    expect(env.git.calls).toEqual([
      ['fetch', env.paths.repo, 'main'],
      ['addWorktree', job.worktree, job.branch, 'origin/main']
    ])
  })

  test('the move must match the decision in intake.md', async () => {
    const env = await makeEnv()
    await seed(env, { agents: REVIEWERS }, { 'intake.md': ACCEPT })
    await expect(env.machine.advance(ID, 'rejected')).rejects.toThrow('DECISION: ACCEPT, not REJECT')
  })

  test('NEEDS-INFO labels the issue and parks the job', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': 'DECISION: NEEDS-INFO\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Questions\n1. which?\n' })
    const job = await env.machine.advance(ID, 'needs-info')
    expect(job.stage).toBe('needs-info')
    expect(job.ended).toBe('2026-11-20T12:00:00Z')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { add: ['factory:needs-info'] }])
  })

  test('REJECT removes the queue label', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': 'DECISION: REJECT\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Why\nno\n' })
    const job = await env.machine.advance(ID, 'rejected')
    expect(job.stage).toBe('rejected')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory'] }])
  })

  test('recordAgents only routes an ACCEPTed intake job', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': 'DECISION: REJECT\n' })
    await expect(env.machine.recordAgents(ID, REVIEWERS)).rejects.toThrow('ACCEPT')
    await env.store.write(ID, 'intake.md', ACCEPT)
    expect((await env.machine.recordAgents(ID, REVIEWERS)).agents).toEqual(REVIEWERS)
  })
})

describe('needs-info → intake', () => {
  test('archives the old intake, refreshes the issue and removes the label', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    env.github.addIssue({ number: 1, comments: [{ author: 'alice', body: 'Use blue.', createdAt: '2026-11-20T11:30:00Z' }] })
    const job = await env.machine.advance(ID, 'intake')
    expect(job.stage).toBe('intake')
    expect(job.intake).toBeNull()
    expect(job.ended).toBeNull()
    expect(await env.store.read(ID, 'intake.md')).toBeNull()
    expect(await env.store.read(ID, 'intake-1.md')).toBe('DECISION: NEEDS-INFO\n')
    expect(await env.store.read(ID, 'issue.md')).toContain('> Use blue.')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory:needs-info'] }])
  })

  test('refuses when every concurrency slot is taken', async () => {
    const env = await makeEnv({ concurrency: 1 })
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    await seed(env, { id: '002-busy', issue: 2, stage: 'build' })
    await expect(env.machine.advance(ID, 'intake')).rejects.toThrow('concurrency 1 reached; running: 002-busy')
  })
})

describe('spec → build', () => {
  test('needs spec.md, then opens round 1', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'spec' })
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('spec.md doesn\'t exist')
    await env.store.write(ID, 'spec.md', '# spec')
    const job = await env.machine.advance(ID, 'build')
    expect(job.round).toBe(1)
    expect(existsSync(join(env.store.dir(ID), 'round-1'))).toBe(true)
  })
})

describe('build → gate', () => {
  const ready = { 'build.md': 'STATUS: READY\n\n# Build\n' }

  test('records the single open PR from the branch', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'build', round: 1 }, ready)
    env.github.openPrs.set(`factory/${ID}`, [{ number: 9, url: 'https://github.com/o/r/pull/9' }])
    const job = await env.machine.advance(ID, 'gate')
    expect(job).toMatchObject({ stage: 'gate', pr: 9, prUrl: 'https://github.com/o/r/pull/9' })
  })

  test.each([
    ['STATUS: BLOCKED\n', (_: unknown) => {}, 'starts with \'STATUS: BLOCKED\', not STATUS: READY'],
    [ready['build.md'], (g: { clean: boolean }) => {
      g.clean = false
    }, 'uncommitted changes'],
    [ready['build.md'], (g: { ahead: number }) => {
      g.ahead = 0
    }, 'no commits on top of origin/main'],
    [ready['build.md'], (g: { remoteSha: string | null }) => {
      g.remoteSha = null
    }, 'isn\'t pushed: local aaaaaaa, origin missing']
  ] as const)('refuses: %#', async (build, mutate, message) => {
    const env = await makeEnv()
    await seed(env, { stage: 'build', round: 1, pr: 9 }, { 'build.md': build })
    mutate(env.git as never)
    await expect(env.machine.advance(ID, 'gate')).rejects.toThrow(message)
  })

  test('refuses without exactly one open PR', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'build', round: 1 }, ready)
    await expect(env.machine.advance(ID, 'gate')).rejects.toThrow('expected one open PR from factory/001-add-a-thing, found 0')
  })
})

describe('build → needs-human', () => {
  test('a BLOCKED build escalates with its Blocked section, on the PR when there is one', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'build', round: 1, pr: 9 }, { 'build.md': 'STATUS: BLOCKED\n\n## Blocked\nThe spec contradicts itself.\n' })
    env.github.drafts.add(9)
    const job = await env.machine.advance(ID, 'needs-human')
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toBe('ESCALATE\n\n## Why\nThe builder is blocked:\n\nThe spec contradicts itself.\n')
    expect(env.github.calls).toContainEqual(['ready', 9])
    expect(env.github.calls).toContainEqual(['comment', 'pr', 9, '### Factory: needs a human\n\n## Why\nThe builder is blocked:\n\nThe spec contradicts itself.'])
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { add: ['factory:needs-human'] }])
  })
})

describe('gate', () => {
  test('PASS → review marks every routed reviewer pending', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'gate', round: 1, pr: 9, agents: REVIEWERS }, { 'round-1/checks.md': checks('PASS') })
    const job = await env.machine.advance(ID, 'review')
    expect(job.reviews).toEqual({ code: 'pending', ux: 'pending' })
  })

  test('refuses checks written for another commit', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'gate', round: 1, pr: 9, agents: REVIEWERS }, { 'round-1/checks.md': checks('PASS', 'b'.repeat(40)) })
    await expect(env.machine.advance(ID, 'review')).rejects.toThrow('another commit')
  })

  test('refuses before the gate ran', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'gate', round: 1, pr: 9, agents: REVIEWERS })
    await expect(env.machine.advance(ID, 'review')).rejects.toThrow('run the gate first')
  })

  test('FAIL → build opens the next round; on the last round it must go to needs-human', async () => {
    const env = await makeEnv({ maxRounds: 2 })
    await seed(env, { stage: 'gate', round: 1, roundLimit: 2, pr: 9, agents: REVIEWERS }, { 'round-1/checks.md': checks('FAIL') })
    await expect(env.machine.advance(ID, 'review')).rejects.toThrow('the gate didn\'t pass')
    await expect(env.machine.advance(ID, 'needs-human')).rejects.toThrow('round 1 of 2: go to build')
    let job = await env.machine.advance(ID, 'build')
    expect(job).toMatchObject({ stage: 'build', round: 2, gate: null })

    await env.store.write(ID, 'build.md', 'STATUS: READY\n')
    expect((await env.machine.advance(ID, 'gate')).stage).toBe('gate')
    await env.store.write(ID, 'round-2/checks.md', checks('FAIL'))
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('round 2 of 2: go to needs-human')
    job = await env.machine.advance(ID, 'needs-human')
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('The gate failed in round 2, the last allowed round.')
  })
})

describe('review', () => {
  const passing = { 'round-1/checks.md': checks('PASS'), 'round-1/review-code.md': 'VERDICT: PASS\n' }

  test('waits for every reviewer', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS }, passing)
    await expect(env.machine.advance(ID, 'approve')).rejects.toThrow('missing reviews from: ux')
  })

  test('refuses a review whose first line is not a verdict', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS }, { ...passing, 'round-1/review-ux.md': 'great\n' })
    await expect(env.machine.advance(ID, 'approve')).rejects.toThrow('first line isn\'t a verdict in review-ux.md')
  })

  test('all PASS → approve; CHANGES refuses approve and opens the next round', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS }, { ...passing, 'round-1/review-ux.md': 'VERDICT: CHANGES\n' })
    await expect(env.machine.advance(ID, 'approve')).rejects.toThrow('reviews want CHANGES: ux')
    const job = await env.machine.advance(ID, 'build')
    expect(job).toMatchObject({ stage: 'build', round: 2, reviews: {} })

    const env2 = await makeEnv()
    await seed(env2, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS }, { ...passing, 'round-1/review-ux.md': 'VERDICT: PASS\n' })
    await expect(env2.machine.advance(ID, 'build')).rejects.toThrow('every review passed')
    expect((await env2.machine.advance(ID, 'approve')).stage).toBe('approve')
  })

  test('CHANGES on the last round escalates', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 3, roundLimit: 3, pr: 9, agents: REVIEWERS }, {
      'round-3/checks.md': checks('PASS'), 'round-3/review-code.md': 'VERDICT: CHANGES\n', 'round-3/review-ux.md': 'VERDICT: PASS\n'
    })
    await env.machine.advance(ID, 'needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('Outstanding CHANGES in round-3/ from: code.')
  })
})

describe('approve', () => {
  test('the move follows decision.md', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS }, { 'decision.md': 'APPROVE\n\n## Why\nfine\n' })
    await expect(env.machine.advance(ID, 'needs-human')).rejects.toThrow('starts with \'APPROVE\', not ESCALATE')
    expect((await env.machine.advance(ID, 'merging')).stage).toBe('merging')
  })

  test('ESCALATE posts the decision on the PR', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS }, { 'decision.md': 'ESCALATE\n\n## For the human\nPricing call.\n' })
    await env.machine.advance(ID, 'needs-human')
    expect(env.github.calls).toContainEqual(['comment', 'pr', 9, '### Factory: needs a human\n\n## For the human\nPricing call.'])
  })
})

describe('merged', () => {
  test('any unfinished job moves to merged once its PR is merged, and its worktree goes', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 1, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    await expect(env.machine.advance(ID, 'merged')).rejects.toThrow('the PR isn\'t merged')
    env.github.prStates.set(9, 'MERGED')
    const job = await env.machine.advance(ID, 'merged')
    expect(job.stage).toBe('merged')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory:needs-human'] }])
  })

  test('a finished job cannot move again', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'merged', pr: 9 })
    env.github.prStates.set(9, 'MERGED')
    await expect(env.machine.advance(ID, 'merged')).rejects.toThrow('not a legal transition')
  })
})

describe('feedback', () => {
  test('needs-human → build with feedback-k.md and a fresh round budget', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 3, roundLimit: 3, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    const { job, file } = await env.machine.feedback(ID, '  Use a dropdown instead.  ', 'octocat')
    expect(file).toBe('feedback-1.md')
    expect(job).toMatchObject({ stage: 'build', round: 4, roundLimit: 6 })
    expect(await env.store.read(ID, 'feedback-1.md')).toBe('# Feedback 1\n\nFrom @octocat after the job escalated.\n\nUse a dropdown instead.\n')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory:needs-human'] }])
  })

  test('refuses empty feedback or a job that is not waiting on a human', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'build', round: 1 })
    await expect(env.machine.feedback(ID, 'x', 'me')).rejects.toThrow('not needs-human')
    await env.store.update(ID, j => ({ ...j, stage: 'needs-human' }))
    await env.store.write(ID, 'decision.md', 'ESCALATE\n')
    await expect(env.machine.feedback(ID, '   ', 'me')).rejects.toThrow('no feedback')
  })

  test('advance alone cannot send a needs-human job back to build', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 1, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('use feedback')
  })
})

describe('reject', () => {
  test('a waiting job: reason on the issue, labels off, PR closed, branch and worktree gone', async () => {
    const env = await makeEnv()
    const seeded = await seed(env, { stage: 'needs-human', round: 1, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    const job = await env.machine.reject(ID, 'Not this quarter.', 'octocat')
    expect(job.stage).toBe('rejected')
    expect(await env.store.read(ID, 'rejection.md')).toBe('REJECTED\n\nBy @octocat while the job was needs-human.\n\nNot this quarter.\n')
    expect(env.github.calls).toContainEqual(['comment', 'issue', 1, '### Factory: rejected\n\nNot this quarter.'])
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory', 'factory:needs-human'] }])
    expect(env.github.calls).toContainEqual(['close', 9])
    expect(env.git.calls).toContainEqual(['deleteRemoteBranch', seeded.branch])
  })

  test('only waiting jobs can be rejected by a human', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1 })
    await expect(env.machine.reject(ID, 'no', 'me')).rejects.toThrow('not needs-info or needs-human')
  })

  test('advance alone cannot reject a waiting job', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-info' })
    await expect(env.machine.advance(ID, 'rejected')).rejects.toThrow('use reject')
  })
})
