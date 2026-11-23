export const STAGES = [
  'intake', 'needs-info', 'spec', 'build', 'gate', 'review',
  'approve', 'merging', 'needs-human', 'merged', 'rejected'
] as const

export type Stage = typeof STAGES[number]
export type Risk = 'low' | 'medium' | 'high'
export type Verdict = 'PASS' | 'CHANGES' | 'pending' | 'invalid'
export type GateVerdict = 'PASS' | 'FAIL'

/** `spec` (first round), `gate` (last gate failed), `review` (reviews want changes), or `feedback:<file>` */
export type RoundReason = 'spec' | 'gate' | 'review' | 'sync' | `feedback:${string}`

export interface IntakeInfo {
  decision: string | null
  rescoped: boolean
  risk: Risk | null
  surfaces: string[]
}

export interface JobAgents {
  /** reviewer lens → model alias, e.g. { code: 'sonnet', ux: 'sonnet' } */
  reviewers: Record<string, string>
}

export interface Job {
  id: string
  issue: number
  title: string
  issueUrl: string | null
  pr: number | null
  prUrl: string | null
  branch: string
  worktree: string
  stage: Stage
  round: number
  roundLimit: number
  intake: IntakeInfo | null
  agents: JobAgents | null
  gate: GateVerdict | null
  reviews: Record<string, Verdict>
  /** why the current round exists: what the builder must address */
  roundReason: RoundReason | null
  /** agent name → Agent SDK session id, so a later round can resume it */
  sessions: Record<string, string>
  /** session id → that session's latest cumulative cost (a resumed session reports its running total) */
  costs: Record<string, number>
  /** sum of `costs` */
  costUsd: number
  started: string
  ended: string | null
  /** the last failure that stalled the job, kept across restarts until it starts again; absent in older jobs */
  error?: { message: string, at: string } | null
  /**
   * the unrepeatable steps a stage change has finished while it isn't saved yet, so a retry of the
   * same move skips them; cleared when the move is saved, written only by the machine; absent in older jobs
   */
  move?: { from: Stage, to: Stage, done: string[] } | null
}

/** One line of a job's events.jsonl, written only by the factory. */
export type JobEvent = { at: string } & (
  | { type: 'stage', from: Stage, to: Stage }
  | { type: 'agent-start', agent: string, model: string, round: number }
  | { type: 'agent-end', agent: string, model: string, round: number, seconds: number, cost: number, ok: boolean, error?: string }
  | { type: 'gate', verdict: GateVerdict, seconds: number, commit: string }
  | { type: 'merge', outcome: Stage | 'error', error?: string }
)

export interface FactoryConfig {
  concurrency: number
  maxRounds: number
  baseBranch: string
  mergeMethod: 'merge' | 'squash' | 'rebase'
  labels: { queue: string, needsInfo: string, needsHuman: string }
  /** fixed models for the single-instance agents */
  models: { intake: string, spec: string, builder: string, approver: string }
  /** risk → reviewers (lens → model) */
  routing: Record<Risk, Record<string, string>>
  /** surface → extra reviewers (lens → model) */
  surfaceReviewers: Record<string, Record<string, string>>
  /** glob patterns for files no job may add, modify or delete (`.factory/*` always is) */
  protectedPaths: string[]
  ports: { base: number, step: number }
  /** a hung test run or a looping agent must not hold a slot forever */
  limits: {
    /** checks.sh wall-clock limit, gate and builder stop check alike */
    checksMinutes: number
    /** turns per agent run */
    agentTurns: number
    /** USD per agent run (a resumed builder counts from the resume) */
    agentBudgetUsd: number
  }
}

export interface FactoryPaths {
  /** the main checkout of the target project */
  repo: string
  /** <repo>/.factory */
  factory: string
  /** <repo>/.factory/jobs */
  jobs: string
  /** <repo>/.worktrees */
  worktrees: string
}
