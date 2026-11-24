import type { PrState } from './ports'

export const STAGES = [
  'intake', 'needs-info', 'spec', 'build', 'gate', 'review',
  'approve', 'merging', 'needs-human', 'merged', 'rejected'
] as const

export type Stage = typeof STAGES[number]

// Here rather than in machine.ts, which has Node imports, so the board can use them too.
export const TERMINAL: ReadonlySet<Stage> = new Set(['merged', 'rejected'])
export const WAITING: ReadonlySet<Stage> = new Set(['needs-info', 'needs-human'])
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

/** What a reviewer or the approver judged, recorded by the factory right after the run. */
export interface Judged {
  verdict: string
  commit: string
  /** origin/<base> when the run started, null when it couldn't be read */
  base: string | null
  round: number
  /** the round whose PASS was copied instead of running the reviewer again */
  reusedFrom?: number
}

export interface JobAgents {
  /** reviewer lens → model alias, e.g. { code: 'sonnet', ux: 'sonnet' } */
  reviewers: Record<string, string>
}

/** What made a job: the factory build, the claude CLI and the base it started from. */
export interface JobProvenance {
  factoryVersion: string
  /** the factory package's git HEAD; for the board, read when its snapshot was taken */
  factorySha: string | null
  claudeVersion: string | null
  /** origin/<base> when the job was created */
  baseSha: string | null
  /** 12-char sha256 prefixes of `.factory/config.json` and `.factory/checks.sh` on that base, null when missing */
  configSha: string | null
  checksSha: string | null
  sandbox: boolean
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
  /**
   * the job's spend cap, set to `costUsd + limits.jobBudgetUsd` when feedback or Merge renews it, written
   * only by the factory; absent in older jobs, and absent or null means the current `limits.jobBudgetUsd`
   */
  budgetLimitUsd?: number | null
  started: string
  ended: string | null
  /** the last failure that stalled the job, kept across restarts until it starts again; absent in older jobs */
  error?: { message: string, at: string } | null
  /** set when `cancel` stopped the job, written only by the factory, kept across restarts until it starts again; absent in older jobs */
  paused?: { by: string, at: string, reason: string } | null
  /**
   * the unrepeatable steps a stage change has finished while it isn't saved yet, so a retry of the
   * same move skips them; cleared when the move is saved, written only by the machine; absent in older jobs
   */
  move?: { from: Stage, to: Stage, done: string[] } | null
  /**
   * the operator's Merge from needs-human: who, the PR head they saw, the decision file it overrode, and the
   * head after the merge step's own base sync; cleared on any move but to merging or merged; absent in older jobs
   */
  override?: { by: string, commit: string, overrides: string | null, synced?: string | null } | null
  /** set once when the job is created, written only by the factory; absent in older jobs */
  provenance?: JobProvenance | null
  /** reviewer lens → its latest record, kept across rounds; written only by the factory; absent in older jobs */
  judged?: Record<string, Judged>
  /** the approver's latest decision record, kept across rounds; written only by the factory; absent in older jobs */
  decided?: Judged | null
  /** who moved the job into merging: the approver's APPROVE or the operator's Merge; set by the machine, absent in older jobs */
  mergeVia?: 'approver' | 'operator' | null
  /** what the factory can prove about the merge, also written as merge.md; never overwritten once set, absent in older jobs */
  merge?: MergeRecord | null
}

export interface MergeRecord {
  /** `factory` after the approver's APPROVE, `operator` after a Merge from needs-human, `external` when merged outside the factory */
  by: 'factory' | 'operator' | 'external'
  /** HEAD when the merge step started */
  approvedCommit: string | null
  /** the commit the last merge gate passed, which `gh pr merge` was pinned to */
  gatedCommit: string | null
  /** the origin/<base> sha that gate ran against */
  base: string | null
  mergeCommit: string | null
  /** the merge commit's tree equals the gated commit's; null when not compared (rebase, external) */
  treeVerified: boolean | null
  ci: 'passed' | 'none-seen' | 'off' | null
  overrides: string[]
}

/** Where an agent's system prompt came from: the built-in one, or a base `<agent>.md` / `<agent>.append.md` */
export type PromptSource = 'builtin' | 'override' | 'addendum'

/** One line of a job's events.jsonl, written only by the factory. */
export type JobEvent = { at: string } & (
  | { type: 'stage', from: Stage, to: Stage }
  | {
    type: 'agent-start'
    agent: string
    model: string
    round: number
    /** the session resumed, null for a new one */
    sessionId: string | null
    /** 2 for a second run in the same session */
    attempt: number
    /** the worktree's HEAD, null before it exists (intake) */
    head: string | null
    base: string | null
    prompt: { source: PromptSource, sha: string }
  }
  | { type: 'agent-end', agent: string, model: string, round: number, seconds: number, cost: number, ok: boolean, error?: string }
  | { type: 'gate', verdict: GateVerdict, seconds: number, commit: string, base: string | null }
  // commit and base of this attempt's gate, null when none ran
  | { type: 'merge', outcome: Stage | 'error', commit: string | null, base: string | null, error?: string }
  | { type: 'pr', pr: number, state: PrState, note: string }
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
    /** wall-clock minutes per agent run; a run past it is aborted and the job stalls */
    agentMinutes: number
    /** USD per job, checked before each builder, reviewer and approver run; reaching it sends the job to a human */
    jobBudgetUsd: number
  }
  /** GitHub CI on the gated commit, waited for between the push and `gh pr merge` */
  ci: {
    /** false merges right after the local gate, without asking GitHub for checks */
    wait: boolean
    /** an empty check list this long after the push means the commit has no CI, so it merges */
    startMinutes: number
    /** checks still pending this long after the push send the job to a human */
    minutes: number
  }
  /** agents' shells and the gate's checks.sh run sandboxed (OS-level write, network and credential limits) */
  sandbox: {
    enabled: boolean
    /** hosts the builder and checks.sh may reach beyond the npm registry (another package registry, say) */
    domains: string[]
    /** largest file, in MB, the factory commits for a sandboxed builder */
    maxFileMB: number
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
