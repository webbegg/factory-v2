import type { Job } from './types'

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type ThreadKind = 'issue' | 'pr'

/** Every GitHub side effect the state machine needs. */
export interface GitHubPort {
  comment(kind: ThreadKind, number: number, body: string): Promise<void>
  editLabels(kind: ThreadKind, number: number, change: { add?: string[], remove?: string[] }): Promise<void>
  prState(number: number): Promise<PrState>
  prIsDraft(number: number): Promise<boolean>
  prReady(number: number): Promise<void>
  prClose(number: number): Promise<void>
  openPrsForBranch(branch: string): Promise<Array<{ number: number, url: string }>>
}

/** Every git side effect the state machine needs. `cwd` is a worktree. */
export interface GitPort {
  fetch(cwd: string, ref: string): Promise<void>
  addWorktree(path: string, branch: string, from: string): Promise<void>
  removeWorktree(path: string): Promise<void>
  deleteBranch(branch: string): Promise<void>
  deleteRemoteBranch(branch: string): Promise<void>
  isClean(cwd: string): Promise<boolean>
  head(cwd: string): Promise<string>
  /** sha of origin/<branch>, or null when it doesn't exist */
  remoteHead(cwd: string, branch: string): Promise<string | null>
  commitsAhead(cwd: string, base: string): Promise<number>
}

/** Refreshes a job's issue.md from GitHub (quoted as data). */
export interface IssuePort {
  refresh(job: Job): Promise<void>
}

export interface Ports {
  github: GitHubPort
  git: GitPort
  issues: IssuePort
  now(): string
}
