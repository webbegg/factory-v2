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
 * `pending` otherwise. Reviewers run one at a time in routing order, so only
 * the first one without a verdict is `running`; the later ones are `pending`.
 */
export function roundChips(job: Pick<Job, 'round' | 'stage' | 'gate' | 'reviews' | 'agents'>, live: boolean): RoundChip[] {
  if (!job.round) return []
  const chips: RoundChip[] = [{ key: 'gate', label: 'gate', state: settled(job.gate, live && job.stage === 'gate') }]
  if (job.gate !== 'PASS') return chips
  let reviewing = live && job.stage === 'review'
  for (const r of Object.keys(job.agents?.reviewers ?? {})) {
    const state = settled(job.reviews[r], reviewing)
    if (state === 'running') reviewing = false
    chips.push({ key: r, label: SHORT[r] ?? r, state })
  }
  return chips
}
