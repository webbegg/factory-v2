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

export const LIVE_STAGES = new Set<Stage>(['intake', 'spec', 'build', 'gate', 'review', 'approve', 'merging'])

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
  if (path === 'decision.md') return 'the approver'
  if (path === 'rejection.md' || /^feedback-\d+\.md$/.test(path)) return 'you'
  return 'the factory'
}
