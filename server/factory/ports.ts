import type { UploadImage } from './attachments'
import type { Job } from './types'

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type ThreadKind = 'issue' | 'pr'

export interface IssueComment {
  author: string
  body: string
  createdAt: string
}

export interface IssueData {
  number: number
  title: string
  body: string
  author: string
  labels: string[]
  state: 'OPEN' | 'CLOSED'
  url: string
  comments: IssueComment[]
}

/** One check run or commit status, reduced to what decides a merge. */
export interface CommitCheck {
  name: string
  state: 'pending' | 'success' | 'failure'
  url: string | null
}

/** Every GitHub side effect the state machine needs. */
export interface GitHubPort {
  /** login of the user running the factory */
  operator(): Promise<string>
  listIssues(label: string): Promise<Array<{ number: number, title: string }>>
  fetchIssue(number: number): Promise<IssueData>
  /** posts `body` prefixed with the factory marker */
  comment(kind: ThreadKind, number: number, body: string): Promise<void>
  editLabels(kind: ThreadKind, number: number, change: { add?: string[], remove?: string[] }): Promise<void>
  prState(number: number): Promise<PrState>
  prIsDraft(number: number): Promise<boolean>
  prReady(number: number): Promise<void>
  prClose(number: number): Promise<void>
  /** merges only while the PR head is still `headSha` */
  prMerge(number: number, method: 'merge' | 'squash' | 'rebase', headSha: string): Promise<void>
  /** every check run and commit status on `sha`; a list GitHub reports as incomplete gets a pending entry */
  commitChecks(sha: string): Promise<CommitCheck[]>
  openPrsForBranch(branch: string): Promise<Array<{ number: number, url: string }>>
  /** opens a draft PR from `head` (pushed already) into `base` */
  prCreate(pr: { base: string, head: string, title: string, body: string }): Promise<{ number: number, url: string }>
  /** hosts images for issue bodies and comments; one URL per image, in order */
  uploadImages(images: UploadImage[]): Promise<string[]>
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
  /** files changed since forking from `base`; status is the git letter (A, M, D, R…) */
  changedFiles(cwd: string, base: string): Promise<Array<{ status: string, path: string }>>
  push(cwd: string, branch: string): Promise<void>
  /** `path` as committed on `ref`, or null when it isn't there */
  show(cwd: string, ref: string, path: string): Promise<string | null>
  /** merges `ref` into the worktree's branch, aborting on conflict */
  merge(cwd: string, ref: string): Promise<{ ok: boolean, output: string }>
  /** merges `ref`, leaving any conflicts in the worktree for someone to resolve; `conflicts` lists their paths */
  startMerge(cwd: string, ref: string): Promise<{ ok: boolean, conflicts: string[] }>
  /**
   * Stages every change and commits it (concluding a started merge). Nothing to
   * commit: `committed` false. Conflict markers left: nothing is committed and
   * `problem` says where.
   */
  commitAll(cwd: string, message: string, maxFileBytes?: number): Promise<{ committed: boolean, problem?: string }>
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
