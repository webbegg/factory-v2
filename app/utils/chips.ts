import type { Job } from '~~/server/factory/types'

export type ChipState = 'pending' | 'running' | 'PASS' | 'CHANGES' | 'FAIL' | 'invalid'

export interface RoundChip {
  key: string
  label: string
  state: ChipState
}

const SHORT: Record<string, string> = { security: 'sec' }

function settled(verdict: string | null | undefined, executing: boolean): ChipState {
  if (verdict === 'PASS' || verdict === 'CHANGES' || verdict === 'FAIL' || verdict === 'invalid') return verdict
  return executing ? 'running' : 'pending'
}

/**
 * The current round's chips: the gate, then each routed reviewer once the gate
 * passed. A step without a verdict is `running` while its stage executes in a
 * job the factory is running (`live`), so stalled jobs stop showing work, and
 * `pending` otherwise.
 */
export function roundChips(job: Pick<Job, 'round' | 'stage' | 'gate' | 'reviews' | 'agents'>, live: boolean): RoundChip[] {
  if (!job.round) return []
  const chips: RoundChip[] = [{ key: 'gate', label: 'gate', state: settled(job.gate, live && job.stage === 'gate') }]
  if (job.gate !== 'PASS') return chips
  for (const r of Object.keys(job.agents?.reviewers ?? {})) {
    chips.push({ key: r, label: SHORT[r] ?? r, state: settled(job.reviews[r], live && job.stage === 'review') })
  }
  return chips
}
