import type { Job } from '~~/server/factory/types'

/** Why a job waits on the operator; a stalled job's error is what blocks it, so it wins. */
export type WaitingReason = 'needs-human' | 'stalled'

/**
 * The jobs that wait on the operator, in `jobs` order, each once: needs-human
 * or stalled (an entry in `errors`). needs-info waits on the issue's author.
 */
export function waitingOnYou<T extends Pick<Job, 'id' | 'stage'>>(jobs: T[], errors: Record<string, string>): T[] {
  return jobs.filter(j => j.stage === 'needs-human' || j.id in errors)
}

export function waitingCount(jobs: Pick<Job, 'id' | 'stage'>[], errors: Record<string, string>): number {
  return waitingOnYou(jobs, errors).length
}

export function pageTitle(count: number): string {
  return count > 0 ? `(${count}) Factory` : 'Factory'
}

export function waitingReasons(jobs: Pick<Job, 'id' | 'stage'>[], errors: Record<string, string>): Record<string, WaitingReason> {
  const reasons: Record<string, WaitingReason> = {}
  for (const j of waitingOnYou(jobs, errors)) reasons[j.id] = j.id in errors ? 'stalled' : 'needs-human'
  return reasons
}

/** The entries of `next` that `prev` lacks or gave another reason: one notification per transition. */
export function newlyWaiting(prev: Record<string, WaitingReason>, next: Record<string, WaitingReason>): { id: string, reason: WaitingReason }[] {
  return Object.entries(next)
    .filter(([id, reason]) => prev[id] !== reason)
    .map(([id, reason]) => ({ id, reason }))
}
