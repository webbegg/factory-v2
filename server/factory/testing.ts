// Test doubles and a scratch environment for the factory engine.
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UploadImage } from './attachments'
import { defaultConfig } from './config'
import { Gate } from './gate'
import { Machine } from './machine'
import { Merger } from './merge'
import { GitHubIssues } from './issue'
import type { CommitCheck, GitHubPort, GitPort, IssueData, Ports, PrState, ThreadKind } from './ports'
import type { BuildInfo } from './provenance'
import { Queue } from './queue'
import { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, Job } from './types'

export type Call = [string, ...unknown[]]

/**
 * Tests that start the real gate sandbox: macOS ships sandbox-exec (Linux
 * needs bubblewrap and socat, which CI doesn't install), and a sandbox can't
 * start inside another, as when the factory gates its own repo (#68).
 */
export const realSandbox = process.platform === 'darwin' && process.env.SANDBOX_RUNTIME !== '1'

/** the tree FakeGit reports for any ref without its own entry */
export const FAKE_TREE = 'e'.repeat(40)
/** the merge commit FakeGitHub's prMerge records when the test set none */
export const MERGE_SHA = 'd'.repeat(40)

export class FakeGitHub implements GitHubPort {
  calls: Call[] = []
  prStates = new Map<number, PrState>()
  drafts = new Set<number>()
  openPrs = new Map<string, Array<{ number: number, url: string }>>()
  issues = new Map<number, IssueData>()
  login = 'operator'

  addIssue(fields: Partial<IssueData> & { number: number }): IssueData {
    const issue: IssueData = {
      title: `Issue ${fields.number}`, body: 'Please build it.', author: 'alice', labels: ['factory'],
      state: 'OPEN', url: `https://github.com/o/r/issues/${fields.number}`, comments: [], ...fields
    }
    this.issues.set(issue.number, issue)
    return issue
  }

  async operator() {
    return this.login
  }

  async listIssues(label: string) {
    return [...this.issues.values()]
      .filter(i => i.state === 'OPEN' && i.labels.includes(label))
      .map(i => ({ number: i.number, title: i.title }))
  }

  async fetchIssue(number: number) {
    const issue = this.issues.get(number)
    if (!issue) throw new Error(`no issue #${number}`)
    return issue
  }

  async comment(kind: ThreadKind, number: number, body: string) {
    this.calls.push(['comment', kind, number, body])
  }

  async editLabels(kind: ThreadKind, number: number, change: { add?: string[], remove?: string[] }) {
    this.calls.push(['labels', kind, number, change])
  }

  async prState(number: number) {
    return this.prStates.get(number) ?? 'OPEN'
  }

  /** PR number → head sha on GitHub; unset PRs report `FakeGit`'s default head */
  prHeads = new Map<number, string>()
  async prHead(number: number) {
    return this.prHeads.get(number) ?? 'a'.repeat(40)
  }

  async prIsDraft(number: number) {
    return this.drafts.has(number)
  }

  async prReady(number: number) {
    this.drafts.delete(number)
    this.calls.push(['ready', number])
  }

  async prClose(number: number) {
    this.calls.push(['close', number])
  }

  mergeError: string | null = null
  /** merges the PR, then throws this, as when gh loses GitHub's response */
  mergeLost: string | null = null
  async prMerge(number: number, method: string, headSha: string) {
    if (this.mergeError) throw new Error(this.mergeError)
    this.prStates.set(number, 'MERGED')
    // a merge commit whose tree matches FakeGit's default, unless the test set one (null included)
    if (!this.mergeCommits.has(number)) this.mergeCommits.set(number, { sha: MERGE_SHA, tree: FAKE_TREE })
    this.calls.push(['merge', number, method, headSha])
    if (this.mergeLost) throw new Error(this.mergeLost)
  }

  /** PR → its merge commit; a PR without an entry has none */
  mergeCommits = new Map<number, { sha: string, tree: string } | null>()
  async prMergeCommit(number: number) {
    this.calls.push(['prMergeCommit', number])
    return this.mergeCommits.get(number) ?? null
  }

  /** answers to `commitChecks`, in order; the last one repeats */
  checkResponses: CommitCheck[][] = [[]]
  private checkCalls = 0
  async commitChecks(sha: string) {
    this.calls.push(['commitChecks', sha])
    return this.checkResponses[Math.min(this.checkCalls++, this.checkResponses.length - 1)] ?? []
  }

  async openPrsForBranch(branch: string) {
    return this.openPrs.get(branch) ?? []
  }

  async prCreate(pr: { base: string, head: string, title: string, body: string }) {
    this.calls.push(['prCreate', pr])
    const created = { number: 900 + this.calls.length, url: `https://github.com/o/r/pull/${900 + this.calls.length}` }
    this.openPrs.set(pr.head, [created])
    return created
  }

  async uploadImages(images: UploadImage[]) {
    this.calls.push(['uploadImages', images.map(i => i.name)])
    return images.map((img, i) => `https://github.com/user-attachments/assets/fake-${i + 1}-${img.name}`)
  }
}

/**
 * `origin/<x>` is ambiguous: git tries refs/origin/<x>, refs/tags/origin/<x> and
 * refs/heads/origin/<x> first, which a shell in a worktree can plant. The
 * factory names the remote-tracking ref in full.
 */
function fullRef(ref: string): string {
  if (/^origin\//.test(ref)) throw new Error(`ambiguous ref ${ref}: use refs/remotes/${ref}`)
  return ref
}

export class FakeGit implements GitPort {
  calls: Call[] = []
  clean = true
  headSha = 'a'.repeat(40)
  remoteSha: string | null = 'a'.repeat(40)
  /** per-branch overrides of `remoteSha`, so origin/<base> can move apart from the job branch */
  remoteHeads = new Map<string, string | null>()
  ahead = 1

  async fetch(cwd: string, ref: string) {
    this.calls.push(['fetch', cwd, ref])
  }

  async addWorktree(path: string, branch: string, from: string) {
    fullRef(from)
    await mkdir(path, { recursive: true })
    this.calls.push(['addWorktree', path, branch, from])
  }

  async removeWorktree(path: string) {
    this.calls.push(['removeWorktree', path])
  }

  async deleteBranch(branch: string) {
    this.calls.push(['deleteBranch', branch])
  }

  async deleteRemoteBranch(branch: string) {
    this.calls.push(['deleteRemoteBranch', branch])
  }

  async isClean() {
    return this.clean
  }

  async head() {
    return this.headSha
  }

  async remoteHead(_cwd: string, branch: string) {
    return this.remoteHeads.has(branch) ? this.remoteHeads.get(branch)! : this.remoteSha
  }

  /** ref → tree sha; any other ref has `defaultTree` */
  trees = new Map<string, string>()
  defaultTree = FAKE_TREE
  async tree(cwd: string, ref: string) {
    this.calls.push(['tree', cwd, ref])
    return this.trees.get(ref) ?? this.defaultTree
  }

  async commitsAhead(_cwd: string, base: string) {
    fullRef(base)
    return this.ahead
  }

  changed: Array<{ status: string, path: string }> = []
  mergeResult = { ok: true, output: '' }
  async changedFiles(_cwd: string, base: string) {
    fullRef(base)
    return this.changed
  }

  async push(cwd: string, branch: string) {
    this.calls.push(['push', cwd, branch])
  }

  /** path → content on origin/<base>, as `show` returns it */
  committed = new Map<string, string>()
  async show(cwd: string, ref: string, path: string) {
    this.calls.push(['show', cwd, fullRef(ref), path])
    return this.committed.get(path) ?? null
  }

  async merge(cwd: string, ref: string) {
    this.calls.push(['merge', cwd, fullRef(ref)])
    return this.mergeResult
  }

  startMergeResult = { ok: false, conflicts: ['src/a.ts'] }
  async startMerge(cwd: string, ref: string) {
    this.calls.push(['startMerge', cwd, fullRef(ref)])
    if (!this.startMergeResult.ok) this.clean = false
    return this.startMergeResult
  }

  /** a problem `commitAll` reports instead of committing, once per entry */
  commitProblems: string[] = []
  async commitAll(cwd: string, message: string, maxFileBytes?: number) {
    this.calls.push(['commitAll', cwd, message, ...maxFileBytes === undefined ? [] : [maxFileBytes]])
    const problem = this.commitProblems.shift()
    if (problem) return { committed: false, problem }
    if (this.clean) return { committed: false }
    this.clean = true
    return { committed: true }
  }
}

export interface TestEnv {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  github: FakeGitHub
  git: FakeGit
  ports: Ports
  machine: Machine
  queue: Queue
  gate: Gate
  merger: Merger
  /** the merger's clock in ms; its sleep advances this instead of waiting */
  clock: { ms: number }
}

/** Fixed, so no test runs git or claude to find out what the factory is. */
export const FAKE_BUILD: BuildInfo = { factoryVersion: '0.0.0-test', factorySha: 'f'.repeat(40), claudeVersion: '2.1.300 (Claude Code)' }

export async function makeEnv(overrides: Partial<FactoryConfig> = {}, build: BuildInfo = FAKE_BUILD): Promise<TestEnv> {
  const repo = await mkdtemp(join(tmpdir(), 'factory-test-'))
  const paths: FactoryPaths = {
    repo,
    factory: join(repo, '.factory'),
    jobs: join(repo, '.factory', 'jobs'),
    worktrees: join(repo, '.worktrees')
  }
  const config = { ...defaultConfig(), ...overrides }
  const store = new JobStore(paths)
  const github = new FakeGitHub()
  const git = new FakeGit()
  const issues = new GitHubIssues(github, store)
  const ports: Ports = { github, git, issues, now: () => '2026-11-20T12:00:00Z' }
  const machine = new Machine({ paths, config, store, ports })
  const queue = new Queue({ paths, config, store, ports, machine, build })
  const gate = new Gate({ paths, config, store, ports })
  const clock = { ms: 0 }
  const merger = new Merger({
    config, store, ports, machine, gate,
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms
    }
  })
  return { paths, config, store, github, git, ports, machine, queue, gate, merger, clock }
}

export function newJob(env: TestEnv, fields: Partial<Job> = {}): Job {
  const id = fields.id ?? '001-add-a-thing'
  return {
    id,
    issue: 1,
    title: 'Add a thing',
    issueUrl: 'https://github.com/o/r/issues/1',
    pr: null,
    prUrl: null,
    branch: `factory/${id}`,
    worktree: join(env.paths.worktrees, id),
    stage: 'intake',
    round: 0,
    roundLimit: env.config.maxRounds,
    intake: null,
    agents: null,
    gate: null,
    reviews: {},
    roundReason: null,
    sessions: {},
    costs: {},
    costUsd: 0,
    started: '2026-11-20T11:00:00Z',
    ended: null,
    error: null,
    ...fields
  }
}

/** Saves a job plus the files that justify its current state. */
export async function seed(env: TestEnv, fields: Partial<Job> = {}, files: Record<string, string> = {}) {
  const job = newJob(env, fields)
  await env.store.save(job)
  for (const [rel, text] of Object.entries(files)) await env.store.write(job.id, rel, text)
  return job
}

export const ACCEPT = 'DECISION: ACCEPT\nRISK: medium\nSURFACES: ui\nRESCOPED: no\n\n## Summary\n- ok\n\n## Scope\nBuild it.\n'
