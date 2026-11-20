export const STAGES = [
  'intake', 'needs-info', 'spec', 'build', 'gate', 'review',
  'approve', 'merging', 'needs-human', 'merged', 'rejected'
] as const

export type Stage = typeof STAGES[number]
export type Risk = 'low' | 'medium' | 'high'
export type Verdict = 'PASS' | 'CHANGES' | 'pending' | 'invalid'
export type GateVerdict = 'PASS' | 'FAIL'

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
  /** agent name → Agent SDK session id, so a later round can resume it */
  sessions: Record<string, string>
  costUsd: number
  started: string
  ended: string | null
}

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
  /** glob patterns for files no job may modify or delete */
  protectedPaths: string[]
  ports: { base: number, step: number }
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
