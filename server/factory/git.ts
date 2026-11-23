import { mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { exec, run } from './exec'
import type { GitPort } from './ports'

/**
 * Hooks and fsmonitor run commands. Agents can write a worktree (and, through
 * a hooks path like .husky, the hooks), so the factory's own git never runs them.
 */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** GitPort over the git CLI. `repo` is the main checkout. */
export class GitCli implements GitPort {
  private common: Promise<string> | null = null

  constructor(private repo: string) {}

  /**
   * Global options for git in `cwd`. In a job worktree, the git dir is named
   * outright: the worktree's `.git` file is agent-writable and could point git
   * at a gitdir whose config runs commands.
   */
  private async scope(cwd: string): Promise<string[]> {
    const at = await realpath(cwd).catch(() => resolve(cwd))
    const worktrees = await realpath(join(this.repo, '.worktrees')).catch(() => resolve(this.repo, '.worktrees'))
    if (dirname(at) !== worktrees) return SAFE
    this.common ??= exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: this.repo }).then(s => s.trim())
    const gitDir = join(await this.common, 'worktrees', basename(at))
    // git records the worktree's own path in its gitdir; a mismatch means it isn't this worktree's
    const recorded = await readFile(join(gitDir, 'gitdir'), 'utf8').catch(() => '')
    const points = await realpath(dirname(recorded.trim())).catch(() => '')
    if (points !== at) throw new Error(`${cwd} isn't a worktree of ${this.repo} (no matching ${gitDir})`)
    return [...SAFE, `--git-dir=${gitDir}`, `--work-tree=${at}`]
  }

  private async git(cwd: string, ...args: string[]) {
    return exec('git', [...await this.scope(cwd), ...args], { cwd })
  }

  private async tryGit(cwd: string, ...args: string[]) {
    return run('git', [...await this.scope(cwd), ...args], { cwd })
  }

  /** Forced and spelled out, so a remote-tracking ref moved by hand is put back to what origin has. */
  async fetch(cwd: string, ref: string) {
    await this.git(cwd, 'fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`)
  }

  /** Safe to call again for the same job: a stage change that failed after it may be retried. */
  async addWorktree(path: string, branch: string, from: string) {
    await mkdir(dirname(path), { recursive: true })
    // macOS temp dirs are reached through /private, so compare real paths
    const want = join(await realpath(dirname(path)), basename(path))
    const list = await this.git(this.repo, 'worktree', 'list', '--porcelain')
    for (const block of list.split('\n\n')) {
      const lines = block.split('\n')
      const at = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
      if (!at || await realpath(at).catch(() => at) !== want) continue
      const found = lines.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? 'a detached HEAD'
      if (found === branch) return
      throw new Error(`${path} is a worktree on ${found}, not ${branch}`)
    }
    const exists = (await this.tryGit(this.repo, 'show-ref', '--verify', '-q', `refs/heads/${branch}`)).code === 0
    if (exists) await this.git(this.repo, 'worktree', 'add', '-q', path, branch)
    else await this.git(this.repo, 'worktree', 'add', '-q', '-b', branch, path, from)
  }

  async removeWorktree(path: string) {
    await this.git(this.repo, 'worktree', 'remove', '--force', path)
  }

  async deleteBranch(branch: string) {
    await this.tryGit(this.repo, 'branch', '-D', branch)
  }

  /** Best effort: GitHub may already have deleted it on merge. */
  async deleteRemoteBranch(branch: string) {
    await this.tryGit(this.repo, 'push', '-q', 'origin', '--delete', branch)
  }

  async isClean(cwd: string) {
    return !(await this.git(cwd, 'status', '--porcelain')).trim()
  }

  async head(cwd: string) {
    return (await this.git(cwd, 'rev-parse', 'HEAD')).trim()
  }

  async remoteHead(cwd: string, branch: string) {
    const res = await this.tryGit(cwd, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`)
    return res.code === 0 ? res.stdout.trim() : null
  }

  async commitsAhead(cwd: string, base: string) {
    return Number((await this.git(cwd, 'rev-list', '--count', `${base}..HEAD`)).trim())
  }

  /** Files the branch changed since it forked from `base`; a rename is a delete plus an add, so both paths show. */
  async changedFiles(cwd: string, base: string): Promise<Array<{ status: string, path: string }>> {
    // -z: without it git C-quotes unusual names ("d\303\251p.yml"), which no pattern matches
    const out = await this.git(cwd, 'diff', '--name-status', '--no-renames', '-z', `${base}...HEAD`)
    const fields = out.split('\0').filter(Boolean)
    const files: Array<{ status: string, path: string }> = []
    for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i]!.charAt(0), path: fields[i + 1]! })
    return files
  }

  async push(cwd: string, branch: string) {
    await this.git(cwd, 'push', '-q', '-u', 'origin', branch)
  }

  async show(cwd: string, ref: string, path: string) {
    const res = await this.tryGit(cwd, 'show', `${ref}:${path}`)
    return res.code === 0 ? res.stdout : null
  }

  /** Merges `ref` into the worktree's branch; aborts and reports on conflict. */
  async merge(cwd: string, ref: string): Promise<{ ok: boolean, output: string }> {
    const res = await this.tryGit(cwd, 'merge', '--no-edit', ref)
    if (res.code === 0) return { ok: true, output: res.stdout }
    await this.tryGit(cwd, 'merge', '--abort')
    return { ok: false, output: (res.stdout + res.stderr).trim() }
  }
}
