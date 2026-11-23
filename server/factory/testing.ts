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
import type { GitHubPort, GitPort, IssueData, Ports, PrState, ThreadKind } from './ports'
import { Queue } from './queue'
import { JobStore } from './store'
import type { FactoryConfig, FactoryPaths, Job } from './types'

export type Call = [string, ...unknown[]]

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
  async prMerge(number: number, method: string, headSha: string) {
    if (this.mergeError) throw new Error(this.mergeError)
    this.prStates.set(number, 'MERGED')
    this.calls.push(['merge', number, method, headSha])
  }

  async openPrsForBranch(branch: string) {
    return this.openPrs.get(branch) ?? []
  }

  async uploadImages(images: UploadImage[]) {
    this.calls.push(['uploadImages', images.map(i => i.name)])
    return images.map((img, i) => `https://github.com/user-attachments/assets/fake-${i + 1}-${img.name}`)
  }
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

  async commitsAhead() {
    return this.ahead
  }

  changed: Array<{ status: string, path: string }> = []
  mergeResult = { ok: true, output: '' }
  async changedFiles() {
    return this.changed
  }

  async push(cwd: string, branch: string) {
    this.calls.push(['push', cwd, branch])
  }

  /** path → content on origin/<base>, as `show` returns it */
  committed = new Map<string, string>()
  async show(cwd: string, ref: string, path: string) {
    this.calls.push(['show', cwd, ref, path])
    return this.committed.get(path) ?? null
  }

  async merge(cwd: string, ref: string) {
    this.calls.push(['merge', cwd, ref])
    return this.mergeResult
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
}

export async function makeEnv(overrides: Partial<FactoryConfig> = {}): Promise<TestEnv> {
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
  const queue = new Queue({ paths, config, store, ports, machine })
  const gate = new Gate({ paths, config, store, ports })
  const merger = new Merger({ config, store, ports, machine, gate })
  return { paths, config, store, github, git, ports, machine, queue, gate, merger }
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
