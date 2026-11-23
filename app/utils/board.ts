import type { Tone } from '~~/server/factory/service'
// Relative, not `~~`: bun test loads this file too, and only Nuxt resolves the alias.
import { STAGES, TERMINAL, WAITING } from '../../server/factory/types'
import type { Stage } from '~~/server/factory/types'

export const COLUMNS: Array<{ label: string, who: string, stages: Stage[], human?: boolean }> = [
  { label: 'Intake', who: 'intake', stages: ['intake', 'needs-info'] },
  { label: 'Spec', who: 'spec writer', stages: ['spec'] },
  { label: 'Build', who: 'builder · gate', stages: ['build', 'gate'] },
  { label: 'Review', who: 'routed reviewers', stages: ['review'] },
  { label: 'Approve', who: 'approver · merge', stages: ['approve', 'merging'] },
  { label: 'Needs you', who: 'you', stages: ['needs-human'], human: true },
  { label: 'Done', who: 'merged · rejected', stages: ['merged', 'rejected'] }
]

/** Stages the factory works in: neither finished nor waiting on someone. */
export const LIVE_STAGES: ReadonlySet<Stage> = new Set(STAGES.filter(s => !TERMINAL.has(s) && !WAITING.has(s)))

/** The index in `COLUMNS` of the column that holds `stage`. */
export function columnIndex(stage: Stage): number {
  return COLUMNS.findIndex(c => c.stages.includes(stage))
}

/**
 * The job the `?job=` query selects, or null. Null while the state hasn't
 * loaded: the caller keeps the URL so a reload selects once the jobs arrive.
 */
export function selectedJobId(query: unknown, jobIds: readonly string[] | null | undefined): string | null {
  if (!jobIds || typeof query !== 'string' || !query) return null
  return jobIds.includes(query) ? query : null
}

/** What Esc does on the board: an overlay keeps it, a text field only loses focus, so typed text survives. */
export function escapeAction(ctx: { overlayOpen: boolean, inTextField: boolean, hasSelection: boolean }): 'ignore' | 'blur' | 'close' {
  if (ctx.overlayOpen) return 'ignore'
  if (ctx.inTextField) return 'blur'
  return ctx.hasSelection ? 'close' : 'ignore'
}

/**
 * The one run action a job's panel offers: Cancel while it runs, Retry once it
 * stalled, Resume when it sits idle in a live stage (cancelled, or after a restart).
 */
export function jobAction(job: { stage: Stage, running: boolean, error: string | null | undefined }): 'cancel' | 'retry' | 'resume' | null {
  if (job.running) return 'cancel'
  if (job.error) return 'retry'
  return LIVE_STAGES.has(job.stage) ? 'resume' : null
}

/** The dot colour of a job file's tone in the panel's file list. */
export function toneColor(t: Tone): string {
  return t === 'good' ? 'bg-success' : t === 'warn' ? 'bg-warning' : t === 'stop' ? 'bg-error' : 'bg-accented'
}

/** Who writes a job file, for the viewer's empty state. */
export function fileWriter(path: string): string {
  const name = path.split('/').pop() ?? path
  const inRound = /^round-\d+\//.test(path)
  if (inRound) {
    if (name === 'checks.md' || name === 'merge-checks.md') return 'the gate'
    const review = /^review-(.+)\.md$/.exec(name)
    if (review) return `the ${review[1]} reviewer`
    return 'the factory'
  }
  if (path === 'intake.md' || /^intake-\d+\.md$/.test(path)) return 'intake'
  if (path === 'spec.md') return 'the spec writer'
  if (path === 'build.md') return 'the builder'
  if (path === 'decision.md' || /^decision-\d+\.md$/.test(path)) return 'the approver'
  if (path === 'rejection.md' || /^feedback-\d+\.md$/.test(path)) return 'you'
  return 'the factory'
}
