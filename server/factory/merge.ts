import type { Gate, GateResult } from './gate'
import { Refused } from './machine'
import { firstLine } from './markdown'
import type { Machine } from './machine'
import type { CommitCheck, Ports } from './ports'
import type { JobStore } from './store'
import type { FactoryConfig, Job, MergeRecord } from './types'

export interface MergerOptions {
  config: FactoryConfig
  store: JobStore
  ports: Ports
  machine: Machine
  gate: Gate
  /** waits `ms`, or less when `signal` aborts; the CI wait's poll interval */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** milliseconds; `ports.now()` is a fixed string in tests, so the CI wait needs its own clock */
  now?: () => number
}

const POLL_MS = 15_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}

/** GitHub's text on one line: no control characters, no backticks to open a code span, at most 200 characters. */
export function cleanCheckText(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function short(sha: string | null): string {
  return sha?.slice(0, 7) ?? 'unknown'
}

/** `- name` plus its link, shown only when it is an https URL. */
function checkLine(check: CommitCheck): string {
  const name = cleanCheckText(check.name) || '(unnamed check)'
  const url = check.url === null ? '' : cleanCheckText(check.url)
  return /^https:\/\/\S+$/.test(url) ? `- ${name}: ${url}` : `- ${name}`
}

type CiOutcome = { merge: true, ci: 'passed' | 'none-seen', note: string } | { merge: false, why: string }

/** repeats of sync, gate, push and CI wait when origin/<base> moved before `gh pr merge` */
const BASE_REPEATS = 2

const OPERATOR_MERGE = 'operator merge of an escalated job'

/**
 * APPROVE → merged, one job at a time. Another job may have merged since this
 * branch was gated, so it syncs with the base, gates again (reusing the round's
 * checks.md only when the sync left HEAD unchanged and its BASE is still
 * origin/<base>), pushes, waits for GitHub CI on the gated commit unless
 * `ci.wait` is off, and merges through
 * `gh pr merge` (branch protection and required checks still apply). Right
 * before the merge it fetches the base again: if it moved since the gate, the
 * sync, gate and CI wait repeat (at most twice, in the same round). After the
 * merge it compares the merge commit's tree with the gated commit's (merge
 * and squash) and saves the merge record; a mismatch, never reverted, hands
 * the job to a human. A conflict with the base goes back to the builder while
 * rounds remain; any other failure, or a conflict on the last round, hands
 * the job to a human.
 */
export class Merger {
  /** merges in flight, chained: two at once would each be gated against a base without the other */
  private lock: Promise<unknown> = Promise.resolve()

  /** jobs whose merge is waiting on GitHub CI; memory only, a restarted merge waits again */
  readonly ciWaiting = new Set<string>()
  /** told when a job enters and leaves the CI wait, so the board can show it */
  onCiWait: ((jobId: string, waiting: boolean) => void) | null = null
  /** the commit and base the latest merge attempt gated, per job; none when that attempt ran no gate */
  readonly gated = new Map<string, { commit: string, base: string | null }>()
  /** told a line for the board's activity feed */
  onLog: ((message: string) => void) | null = null

  constructor(private o: MergerOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  /**
   * Polls the checks on the gated commit until they settle. Both limits count
   * from the push: an empty list at `startMinutes` means the commit has no CI,
   * and anything still pending at `minutes` goes to a human.
   */
  private async waitForCi(id: string, commit: string, pushedAt: number, signal?: AbortSignal): Promise<CiOutcome> {
    const { ports, config } = this.o
    const short = commit.slice(0, 7)
    this.ciWaiting.add(id)
    this.onCiWait?.(id, true)
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('merge cancelled')
        const checks = await ports.github.commitChecks(commit)
        const failed = checks.filter(c => c.state === 'failure')
        if (failed.length) return { merge: false, why: `GitHub CI failed on ${short}:\n\n${failed.map(checkLine).join('\n')}` }
        const pending = checks.filter(c => c.state === 'pending')
        if (checks.length && !pending.length) return { merge: true, ci: 'passed', note: `Every check on ${short} passed.` }
        const elapsed = this.now() - pushedAt
        if (!checks.length && elapsed >= config.ci.startMinutes * 60_000) {
          return { merge: true, ci: 'none-seen', note: `No check runs or statuses appeared on ${short} within ${config.ci.startMinutes} minutes, so the merge went ahead.` }
        }
        if (elapsed >= config.ci.minutes * 60_000) {
          return { merge: false, why: `GitHub CI was still running on ${short} after ${config.ci.minutes} minutes:\n\n${pending.map(checkLine).join('\n') || '- no check appeared'}` }
        }
        await (this.o.sleep ?? sleep)(POLL_MS, signal)
      }
    } finally {
      this.ciWaiting.delete(id)
      this.onCiWait?.(id, false)
    }
  }

  merge(id: string, signal?: AbortSignal): Promise<Job> {
    const next = this.lock.catch(() => {}).then(() => this.mergeNow(id, signal))
    this.lock = next
    return next
  }

  private async mergeNow(id: string, signal?: AbortSignal): Promise<Job> {
    const { store, ports, machine, gate, config } = this.o
    const base = config.baseBranch
    this.gated.delete(id)
    let job = await store.load(id)
    if (job.stage === 'approve') job = await machine.advance(id, 'merging')
    if (job.stage !== 'merging') throw new Refused(`${id} is in ${job.stage}, not approve or merging`)
    const pr = job.pr
    if (!pr) throw new Refused(`${id} has no PR`)
    if (await ports.github.prState(pr) === 'MERGED') return machine.advance(id, 'merged')

    const fail = async (why: string) => {
      // the approver's APPROVE stays readable as decision-<k>.md
      await store.archive(id, 'decision.md')
      await store.write(id, 'decision.md', `ESCALATE\n\n## Why\n${why}\n`)
      return machine.advance(id, 'needs-human')
    }

    const before = await ports.git.head(job.worktree)
    const override = job.override
    // the operator chose Merge for the commit they saw; the factory's own base sync is the only other head allowed
    if (override && before !== override.commit && before !== override.synced) {
      return fail(`The branch moved from ${override.commit.slice(0, 7)} to ${before.slice(0, 7)} since @${override.by} chose Merge, `
        + 'so it was not merged. Look at the new commits and decide again.')
    }
    const checksFile = `round-${job.round}/merge-checks.md`
    let result: GateResult | null = null
    let ci: MergeRecord['ci'] = 'off'
    for (let repeat = 0; ; repeat++) {
      if (result) {
        // each attempt's BASE stays readable as merge-checks-<k>.md
        await store.archive(id, checksFile)
        this.onLog?.(`${id}: origin/${base} moved since the merge gate; syncing and gating again`)
      }
      await ports.git.fetch(job.worktree, base)
      const synced = await ports.git.merge(job.worktree, `refs/remotes/origin/${base}`)
      if (!synced.ok) {
        await store.write(id, `round-${job.round}/sync.md`, `# Conflict with ${base}\n\n\`\`\`\n${synced.output}\n\`\`\`\n`)
        if (job.round < job.roundLimit) return machine.advance(id, 'build')
        return fail(`The branch conflicts with ${base}:\n\n\`\`\`\n${synced.output}\n\`\`\``)
      }
      if (override) {
        const head = await ports.git.head(job.worktree)
        await store.update(id, j => ({ ...j, override: j.override && { ...j.override, synced: head } }))
      }

      const headUnchanged = await ports.git.head(job.worktree) === before
      result = await gate.run(id, { merge: true, signal, headUnchanged })
      this.gated.set(id, { commit: result.commit, base: result.base })
      // stopped mid-gate: leave the job in merging for the next start
      if (signal?.aborted) throw new Error('merge cancelled')
      if (result.verdict !== 'PASS') {
        return fail(`The gate failed after syncing with ${base}. See ${checksFile}.\n\n${result.line}`)
      }

      let current: string | null
      try {
        await ports.git.push(job.worktree, job.branch)
        const pushedAt = this.now()
        if (await ports.github.prIsDraft(pr)) await ports.github.prReady(pr)
        if (config.ci.wait) {
          const outcome = await this.waitForCi(id, result.commit, pushedAt, signal)
          if (!outcome.merge) return fail(outcome.why)
          ci = outcome.ci
          // after the gate's content: its GATE/COMMIT/BASE header is read back elsewhere
          await store.write(id, checksFile, `${(await store.read(id, checksFile) ?? '').trimEnd()}\n\n## GitHub CI\n${outcome.note}\n`)
        }
        // another merge into the base, say during the CI wait, leaves GitHub merging onto a base nobody gated
        await ports.git.fetch(job.worktree, base)
        current = await ports.git.remoteHead(job.worktree, base)
      } catch (err) {
        if (signal?.aborted) throw new Error('merge cancelled', { cause: err })
        return fail(`The merge failed:\n\n\`\`\`\n${(err as Error).message}\n\`\`\``)
      }
      if (result.base && result.base !== 'unknown' && current === result.base) break
      if (repeat === BASE_REPEATS) {
        return fail(`origin/${base} kept moving: it moved again after ${BASE_REPEATS} repeats of the sync and merge gate, so the merge did not go ahead. `
          + `The last merge gate ran against BASE ${short(result.base)}; origin/${base} is now ${short(current)}.`)
      }
    }

    try {
      // pinned to the gated commit: a push after the gate makes GitHub refuse the merge
      await ports.github.prMerge(pr, config.mergeMethod, result.commit)
    } catch (err) {
      if (signal?.aborted) throw new Error('merge cancelled', { cause: err })
      const message = (err as Error).message
      // gh can fail after GitHub merged, e.g. when the response is lost; GitHub's state is the record
      const state = await ports.github.prState(pr).catch(() => null)
      if (state !== 'MERGED') return fail(`The merge failed:\n\n\`\`\`\n${message}\n\`\`\``)
      const note = `merge response lost: gh pr merge failed (${firstLine(message)}), but GitHub shows PR #${pr} merged.`
      await store.write(id, checksFile, `${(await store.read(id, checksFile) ?? '').trimEnd()}\n\n## Merge\n${note}\n`)
      await store.appendEvent(id, { at: ports.now(), type: 'pr', pr, state, note: 'merge response lost' })
      this.onLog?.(`${id}: PR #${pr} merge response lost; GitHub shows it merged`)
    }

    const merged = await ports.github.prMergeCommit(pr).catch(() => null)
    // rebase leaves no merge commit whose tree stands for the whole PR
    let treeVerified: boolean | null = null
    if (config.mergeMethod !== 'rebase') {
      const gatedTree = merged ? await ports.git.tree(job.worktree, result.commit).catch(() => null) : null
      // no merge commit, or no tree to compare, means the merged result can't be confirmed
      treeVerified = !!gatedTree && gatedTree === merged?.tree
    }
    const by = job.mergeVia === 'operator' ? 'operator' : 'factory'
    await machine.recordMerge(id, {
      by, approvedCommit: before, gatedCommit: result.commit, base: result.base,
      mergeCommit: merged?.sha ?? null, treeVerified, ci, overrides: by === 'operator' ? [OPERATOR_MERGE] : []
    })
    if (treeVerified === false) {
      const what = merged
        ? `PR #${pr} merged as ${short(merged.sha)}, whose tree differs from the gated commit ${short(result.commit)}'s.`
        : `GitHub reports no merge commit for PR #${pr}, so the merged tree couldn't be checked against the gated commit ${short(result.commit)}.`
      return fail(`${what} Nothing was reverted, and the branch was kept for inspection. See merge.md.`)
    }
    await ports.git.deleteRemoteBranch(job.branch)
    return machine.advance(id, 'merged')
  }
}
