import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { exec, run } from './exec'
import type { GitPort } from './ports'

/** GitPort over the git CLI. `repo` is the main checkout. */
export class GitCli implements GitPort {
  constructor(private repo: string) {}

  private git(cwd: string, ...args: string[]) {
    return exec('git', args, { cwd })
  }

  async fetch(cwd: string, ref: string) {
    await this.git(cwd, 'fetch', '-q', 'origin', ref)
  }

  async addWorktree(path: string, branch: string, from: string) {
    await mkdir(dirname(path), { recursive: true })
    await this.git(this.repo, 'worktree', 'add', '-q', '-b', branch, path, from)
  }

  async removeWorktree(path: string) {
    await this.git(this.repo, 'worktree', 'remove', '--force', path)
  }

  async deleteBranch(branch: string) {
    await run('git', ['branch', '-D', branch], { cwd: this.repo })
  }

  /** Best effort: GitHub may already have deleted it on merge. */
  async deleteRemoteBranch(branch: string) {
    await run('git', ['push', '-q', 'origin', '--delete', branch], { cwd: this.repo })
  }

  async isClean(cwd: string) {
    return !(await this.git(cwd, 'status', '--porcelain')).trim()
  }

  async head(cwd: string) {
    return (await this.git(cwd, 'rev-parse', 'HEAD')).trim()
  }

  async remoteHead(cwd: string, branch: string) {
    const res = await run('git', ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { cwd })
    return res.code === 0 ? res.stdout.trim() : null
  }

  async commitsAhead(cwd: string, base: string) {
    return Number((await this.git(cwd, 'rev-list', '--count', `${base}..HEAD`)).trim())
  }

  /** Files the branch changed since it forked from `base`; a rename is a delete plus an add, so both paths show. */
  async changedFiles(cwd: string, base: string): Promise<Array<{ status: string, path: string }>> {
    const out = await this.git(cwd, 'diff', '--name-status', '--no-renames', `${base}...HEAD`)
    return out.split('\n').filter(Boolean).map((line) => {
      const [status = '', path = ''] = line.split('\t')
      return { status: status.charAt(0), path }
    })
  }

  async push(cwd: string, branch: string) {
    await this.git(cwd, 'push', '-q', '-u', 'origin', branch)
  }

  /** Merges `ref` into the worktree's branch; aborts and reports on conflict. */
  async merge(cwd: string, ref: string): Promise<{ ok: boolean, output: string }> {
    const res = await run('git', ['merge', '--no-edit', ref], { cwd })
    if (res.code === 0) return { ok: true, output: res.stdout }
    await run('git', ['merge', '--abort'], { cwd })
    return { ok: false, output: (res.stdout + res.stderr).trim() }
  }
}
