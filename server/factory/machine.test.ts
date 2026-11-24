import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Refused, TRANSITIONS } from './machine'
import { ACCEPT, makeEnv, seed } from './testing'
import { STAGES } from './types'
import type { Judged } from './types'

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
    await seed(env, { stage: 'spec' }, { 'spec.md': '# s\n\n## Acceptance criteria\n' })
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
      ['addWorktree', job.worktree, job.branch, 'refs/remotes/origin/main']
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
    await env.store.write(ID, 'spec.md', '# spec\n\n## Acceptance criteria \n1. It works.\n')
    const job = await env.machine.advance(ID, 'build')
    expect(job.round).toBe(1)
    expect(job.roundReason).toBe('spec')
    expect(existsSync(join(env.store.dir(ID), 'round-1'))).toBe(true)
  })

  test('needs a ## Acceptance criteria heading in spec.md', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'spec' }, { 'spec.md': '# spec\n\nAcceptance criteria: it works.\n' })
    const err = await env.machine.advance(ID, 'build').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Refused)
    expect((err as Refused).message).toContain('## Acceptance criteria')
    expect((await env.store.load(ID)).stage).toBe('spec')
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
    expect(job).toMatchObject({ stage: 'build', round: 2, gate: null, roundReason: 'gate' })

    await env.store.write(ID, 'build.md', 'STATUS: READY\n')
    expect((await env.machine.advance(ID, 'gate')).stage).toBe('gate')
    await env.store.write(ID, 'round-2/checks.md', checks('FAIL'))
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('round 2 of 2: go to needs-human')
    job = await env.machine.advance(ID, 'needs-human')
    expect(job.stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toContain('The gate failed in round 2, the last allowed round.')
  })
})

/** the factory's record of a review or decision; on the fake HEAD in round 1 unless told otherwise */
const judged = (verdict: string, fields: Partial<Judged> = {}): Judged => ({ verdict, commit: SHA, base: null, round: 1, ...fields })

describe('review', () => {
  const passing = { 'round-1/checks.md': checks('PASS'), 'round-1/review-code.md': 'VERDICT: PASS\n' }
  const bothJudged = { judged: { code: judged('PASS'), ux: judged('PASS') } }

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
    expect(job).toMatchObject({ stage: 'build', round: 2, reviews: {}, roundReason: 'review' })

    const env2 = await makeEnv()
    await seed(env2, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS, ...bothJudged }, { ...passing, 'round-1/review-ux.md': 'VERDICT: PASS\n' })
    await expect(env2.machine.advance(ID, 'build')).rejects.toThrow('every review passed')
    expect((await env2.machine.advance(ID, 'approve')).stage).toBe('approve')
  })

  test('a new round keeps the review and decision records', async () => {
    const env = await makeEnv()
    const records = { judged: { code: judged('PASS'), ux: judged('CHANGES') }, decided: judged('APPROVE') }
    await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS, ...records }, { ...passing, 'round-1/review-ux.md': 'VERDICT: CHANGES\n' })
    expect(await env.machine.advance(ID, 'build')).toMatchObject({ round: 2, reviews: {}, ...records })
  })

  describe('approve needs every routed review recorded on HEAD in this round', () => {
    const allPass = { ...passing, 'round-1/review-ux.md': 'VERDICT: PASS\n' }

    test('a review judged on another commit is refused, naming the lens and both commits', async () => {
      const env = await makeEnv()
      const head = '89abcde'.padEnd(40, '0')
      await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS, judged: { code: judged('PASS', { commit: head }), ux: judged('PASS', { commit: '1234567'.padEnd(40, '0') }) } }, allPass)
      env.git.headSha = head
      const refusal = env.machine.advance(ID, 'approve')
      await expect(refusal).rejects.toThrow(Refused)
      await expect(refusal).rejects.toThrow('review-ux.md was judged on 1234567, HEAD is 89abcde; run the review again')
      expect((await env.store.load(ID)).stage).toBe('review')
    })

    test('a missing record is refused', async () => {
      const env = await makeEnv()
      await seed(env, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS, judged: { ux: judged('PASS') } }, allPass)
      await expect(env.machine.advance(ID, 'approve')).rejects.toThrow('review-code.md was judged on none, HEAD is aaaaaaa')
      const older = await makeEnv()
      await seed(older, { stage: 'review', round: 1, pr: 9, agents: REVIEWERS }, allPass)
      await expect(older.machine.advance(ID, 'approve')).rejects.toThrow(Refused)
    })

    test('a record from an earlier round is refused', async () => {
      const env = await makeEnv()
      await seed(env, { stage: 'review', round: 2, pr: 9, agents: REVIEWERS, judged: { code: judged('PASS', { round: 2 }), ux: judged('PASS') } }, {
        'round-2/checks.md': checks('PASS'), 'round-2/review-code.md': 'VERDICT: PASS\n', 'round-2/review-ux.md': 'VERDICT: PASS\n'
      })
      await expect(env.machine.advance(ID, 'approve')).rejects.toThrow('review-ux.md was judged on aaaaaaa in round 1, HEAD is aaaaaaa')
    })
  })

  test('recordReview saves the record with the current round, only for a routed lens in review', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 2, pr: 9, agents: REVIEWERS })
    const job = await env.machine.recordReview(ID, 'code', { verdict: 'PASS', commit: SHA, base: 'b'.repeat(40) })
    expect(job.judged).toEqual({ code: { verdict: 'PASS', commit: SHA, base: 'b'.repeat(40), round: 2 } })
    await expect(env.machine.recordReview(ID, 'security', { verdict: 'PASS', commit: SHA, base: null })).rejects.toThrow('no security reviewer routed')
    await expect(env.machine.recordDecision(ID, { verdict: 'APPROVE', commit: SHA, base: null })).rejects.toThrow('not approve')
    const built = await makeEnv()
    await seed(built, { stage: 'build', round: 2, agents: REVIEWERS })
    await expect(built.machine.recordReview(ID, 'code', { verdict: 'PASS', commit: SHA, base: null })).rejects.toThrow('not review')
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
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS, decided: judged('APPROVE') }, { 'decision.md': 'APPROVE\n\n## Why\nfine\n' })
    await expect(env.machine.advance(ID, 'needs-human')).rejects.toThrow('starts with \'APPROVE\', not ESCALATE')
    expect((await env.machine.advance(ID, 'merging')).stage).toBe('merging')
  })

  test('merging needs the decision recorded on HEAD in this round', async () => {
    const decision = { 'decision.md': 'APPROVE\n\n## Why\nfine\n' }
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS, decided: judged('APPROVE', { commit: '1234567'.padEnd(40, '0') }) }, decision)
    env.git.headSha = '89abcde'.padEnd(40, '0')
    await expect(env.machine.advance(ID, 'merging')).rejects.toThrow('decision.md was decided on 1234567, HEAD is 89abcde; run the approver again')
    expect((await env.store.load(ID)).stage).toBe('approve')

    for (const decided of [null, undefined, judged('APPROVE', { round: 0 })]) {
      const other = await makeEnv()
      await seed(other, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS, decided }, decision)
      await expect(other.machine.advance(ID, 'merging')).rejects.toThrow(Refused)
    }
  })

  test('recordDecision saves the record with the current round, only in approve', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 2, pr: 9, agents: REVIEWERS })
    const job = await env.machine.recordDecision(ID, { verdict: 'APPROVE', commit: SHA, base: null })
    expect(job.decided).toEqual({ verdict: 'APPROVE', commit: SHA, base: null, round: 2 })
    await expect(env.machine.recordReview(ID, 'code', { verdict: 'PASS', commit: SHA, base: null })).rejects.toThrow('not review')
  })

  test('ESCALATE needs no decision record', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS }, { 'decision.md': 'ESCALATE\n\n## Why\nx\n' })
    expect((await env.machine.advance(ID, 'needs-human')).stage).toBe('needs-human')
  })

  test('ESCALATE posts the decision on the PR', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'approve', round: 1, pr: 9, agents: REVIEWERS }, { 'decision.md': 'ESCALATE\n\n## For the human\nPricing call.\n' })
    await env.machine.advance(ID, 'needs-human')
    expect(env.github.calls).toContainEqual(['comment', 'pr', 9, '### Factory: needs a human\n\n## For the human\nPricing call.'])
  })
})

describe('merging', () => {
  const conflict = '# Conflict with main\n\n```\nCONFLICT (content): a.txt\n```\n'

  test('a conflict with rounds left → build opens the next round; needs sync.md', async () => {
    const env = await makeEnv({ maxRounds: 2 })
    await seed(env, { stage: 'merging', round: 1, roundLimit: 2, pr: 9, agents: REVIEWERS })
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('round-1/sync.md doesn\'t exist')
    await env.store.write(ID, 'round-1/sync.md', conflict)
    await env.store.write(ID, 'decision.md', 'ESCALATE\n\n## Why\nconflict\n')
    await expect(env.machine.advance(ID, 'needs-human')).rejects.toThrow('round 1 of 2: go to build')
    const job = await env.machine.advance(ID, 'build')
    expect(job).toMatchObject({ stage: 'build', round: 2, roundReason: 'sync', gate: null, reviews: {} })
    expect(existsSync(env.store.path(ID, 'round-2'))).toBe(true)
    expect(env.github.calls).toEqual([])
  })

  test('a conflict on the last round must go to needs-human', async () => {
    const env = await makeEnv({ maxRounds: 2 })
    await seed(env, { stage: 'merging', round: 2, roundLimit: 2, pr: 9, agents: REVIEWERS }, {
      'round-2/sync.md': conflict, 'decision.md': 'ESCALATE\n\n## Why\nThe branch conflicts with main.\n'
    })
    await expect(env.machine.advance(ID, 'build')).rejects.toThrow('round 2 of 2: go to needs-human')
    const job = await env.machine.advance(ID, 'needs-human')
    expect(job.stage).toBe('needs-human')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { add: ['factory:needs-human'] }])
  })

  test('other merge failures escalate on any round', async () => {
    const env = await makeEnv({ maxRounds: 2 })
    await seed(env, { stage: 'merging', round: 1, roundLimit: 2, pr: 9, agents: REVIEWERS }, {
      'decision.md': 'ESCALATE\n\n## Why\nThe merge failed.\n'
    })
    expect((await env.machine.advance(ID, 'needs-human')).stage).toBe('needs-human')
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
    expect(job).toMatchObject({ stage: 'build', round: 4, roundLimit: 6, roundReason: 'feedback:feedback-1.md' })
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

describe('approve', () => {
  test('needs-human → merging with an operator APPROVE and a fresh round budget, in the same round', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 3, roundLimit: 3, pr: 9 }, { 'decision.md': 'ESCALATE\n\n## Why\nx\n' })
    const job = await env.machine.approve(ID, 'octocat')
    expect(job).toMatchObject({ stage: 'merging', round: 3, roundLimit: 6 })
    expect(await env.store.read(ID, 'decision-1.md')).toBe('ESCALATE\n\n## Why\nx\n')
    const decision = await env.store.read(ID, 'decision.md')
    expect(decision).toStartWith('APPROVE\n')
    expect(decision).toContain('@octocat')
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { remove: ['factory:needs-human'] }])
    expect(existsSync(env.store.path(ID, 'round-4'))).toBe(false)
  })

  test('a conflict left from before the approval is set aside', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 2, roundLimit: 2, pr: 9 }, {
      'decision.md': 'ESCALATE\n', 'round-2/sync.md': '# Conflict\n'
    })
    await env.machine.approve(ID, 'octocat')
    expect(await env.store.read(ID, 'round-2/sync.md')).toBeNull()
    expect(await env.store.read(ID, 'round-2/sync-1.md')).toBe('# Conflict\n')
    // a gate failure after this approval's clean sync escalates, though rounds remain
    await env.store.write(ID, 'decision.md', 'ESCALATE\n\n## Why\ngate\n')
    expect((await env.machine.advance(ID, 'needs-human')).stage).toBe('needs-human')
  })

  test('refused outside needs-human or without a PR', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'review', round: 1, pr: 9 })
    await expect(env.machine.approve(ID, 'me')).rejects.toThrow('is in review, not needs-human')
    await env.store.update(ID, j => ({ ...j, stage: 'needs-human', pr: null }))
    await env.store.write(ID, 'decision.md', 'ESCALATE\n')
    await expect(env.machine.approve(ID, 'me')).rejects.toThrow(Refused)
    expect((await env.store.load(ID)).stage).toBe('needs-human')
    expect(await env.store.read(ID, 'decision.md')).toBe('ESCALATE\n')
  })

  test('advance alone cannot move a needs-human job to merging', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 1, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    await expect(env.machine.advance(ID, 'merging')).rejects.toThrow('use approve')
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

type Env = Awaited<ReturnType<typeof makeEnv>>

/** The next editLabels call throws, as GitHub might after an earlier step went through. */
function labelsFailOnce(env: Env) {
  const edit = env.github.editLabels.bind(env.github)
  let failed = false
  env.github.editLabels = async (...args) => {
    if (failed) return edit(...args)
    failed = true
    throw new Error('gh: 502')
  }
}

const issueComments = (env: Env) => env.github.calls.filter(c => c[0] === 'comment' && c[1] === 'issue')

describe('a move retried after a failed step', () => {
  test('intake → needs-info posts its comment once and clears the record', async () => {
    const env = await makeEnv()
    await seed(env, {}, { 'intake.md': 'DECISION: NEEDS-INFO\nRISK: low\nSURFACES: none\nRESCOPED: no\n\n## Questions\n1. which?\n' })
    labelsFailOnce(env)
    await expect(env.machine.advance(ID, 'needs-info')).rejects.toThrow('gh: 502')
    const pending = await env.store.load(ID)
    expect(pending.stage).toBe('intake')
    expect(pending.move?.from).toBe('intake')
    expect(pending.move?.to).toBe('needs-info')
    expect(pending.move?.done.filter(k => k.startsWith('comment:'))).toHaveLength(1)

    await env.machine.advance(ID, 'needs-info')
    expect(issueComments(env)).toHaveLength(1)
    expect(env.github.calls).toContainEqual(['labels', 'issue', 1, { add: ['factory:needs-info'] }])
    const saved = await env.store.load(ID)
    expect(saved.stage).toBe('needs-info')
    expect(saved.move).toBeNull()
  })

  test('needs-info → intake can be retried after the rename', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    env.github.addIssue({ number: 1 })
    labelsFailOnce(env)
    await expect(env.machine.advance(ID, 'intake')).rejects.toThrow('gh: 502')
    expect((await env.store.load(ID)).move?.done).toEqual(['rename:intake.md'])

    const job = await env.machine.advance(ID, 'intake')
    expect(job.stage).toBe('intake')
    expect(job.intake).toBeNull()
    expect(await env.store.read(ID, 'intake-1.md')).toBe('DECISION: NEEDS-INFO\n')
    expect(await env.store.read(ID, 'intake-2.md')).toBeNull()
    expect(await env.store.files(ID, /^intake/)).toEqual(['intake-1.md'])
    expect((await env.store.load(ID)).move).toBeNull()
  })

  test('a record from another move skips nothing', async () => {
    const env = await makeEnv()
    await seed(env, { agents: REVIEWERS }, { 'intake.md': ACCEPT })
    const add = env.git.addWorktree.bind(env.git)
    let failed = false
    env.git.addWorktree = async (...args) => {
      if (failed) return add(...args)
      failed = true
      throw new Error('git: busy')
    }
    await expect(env.machine.advance(ID, 'spec')).rejects.toThrow('git: busy')
    const pending = await env.store.load(ID)
    const done = pending.move!.done
    expect(done.filter(k => k.startsWith('comment:'))).toHaveLength(1)

    // the same comment key, but recorded for a different move
    await env.store.save({ ...pending, move: { from: 'intake', to: 'needs-info', done } })
    const job = await env.machine.advance(ID, 'spec')
    expect(job.stage).toBe('spec')
    expect(issueComments(env)).toHaveLength(2)
    expect(issueComments(env)[1]![3]).toStartWith('### Factory intake: ACCEPT')
    expect((await env.store.load(ID)).move).toBeNull()
  })

  test('reject retried after a failed branch delete closes the PR and comments once', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-human', round: 1, pr: 9 }, { 'decision.md': 'ESCALATE\n' })
    const del = env.git.deleteRemoteBranch.bind(env.git)
    let failed = false
    env.git.deleteRemoteBranch = async (branch) => {
      if (failed) return del(branch)
      failed = true
      throw new Error('push: denied')
    }
    await expect(env.machine.reject(ID, 'No.', 'me')).rejects.toThrow('push: denied')
    await env.machine.reject(ID, 'No.', 'me')
    expect(issueComments(env)).toHaveLength(1)
    expect(env.github.calls.filter(c => c[0] === 'close')).toHaveLength(1)
    expect(env.github.calls.filter(c => c[0] === 'labels')).toHaveLength(1)
    expect(env.git.calls.filter(c => c[0] === 'deleteRemoteBranch')).toHaveLength(1)
    expect((await env.store.load(ID)).stage).toBe('rejected')
  })
})

describe('answer', () => {
  test('only a needs-info job can be answered', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'spec' })
    let calls = 0
    const reply = async () => {
      calls += 1
    }
    await expect(env.machine.answer(ID, 'blue', reply)).rejects.toThrow('not needs-info')
    expect(calls).toBe(0)
  })

  test('refused for concurrency, then repeated after the slot frees, posts one reply', async () => {
    const env = await makeEnv({ concurrency: 1 })
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    const busy = await seed(env, { id: '002-busy', issue: 2, stage: 'build' })
    env.github.addIssue({ number: 1 })
    const replies: Array<[number, string]> = []
    const reply = async (n: number, text: string) => {
      replies.push([n, text])
    }
    await expect(env.machine.answer(ID, 'Use blue.', reply)).rejects.toThrow('concurrency 1 reached')
    expect(replies).toEqual([])
    await env.store.save({ ...busy, stage: 'merged' })
    const job = await env.machine.answer(ID, 'Use blue.', reply)
    expect(job.stage).toBe('intake')
    expect(replies).toEqual([[1, 'Use blue.']])
    expect((await env.store.load(ID)).move).toBeNull()
  })

  test('a move that fails after the reply, answered again with the same text, posts one reply', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    let calls = 0
    const reply = async () => {
      calls += 1
    }
    env.github.addIssue({ number: 1 })
    labelsFailOnce(env)
    await expect(env.machine.answer(ID, 'Use blue.', reply)).rejects.toThrow('gh: 502')
    expect((await env.store.load(ID)).stage).toBe('needs-info')
    const job = await env.machine.answer(ID, 'Use blue.', reply)
    expect(job.stage).toBe('intake')
    expect(calls).toBe(1)
    expect(await env.store.files(ID, /^intake/)).toEqual(['intake-1.md'])
  })

  test('the reply is on the issue before the issue is read again', async () => {
    const env = await makeEnv()
    await seed(env, { stage: 'needs-info' }, { 'intake.md': 'DECISION: NEEDS-INFO\n' })
    env.github.addIssue({ number: 1 })
    await env.machine.answer(ID, 'Use blue.', async (n, text) => {
      env.github.issues.get(n)!.comments.push({ author: 'operator', body: text, createdAt: '2026-11-20T11:30:00Z' })
    })
    expect(await env.store.read(ID, 'issue.md')).toContain('> Use blue.')
  })
})
