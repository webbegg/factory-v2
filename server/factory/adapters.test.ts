import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from './exec'
import { GhCli } from './gh'
import { GitCli } from './git'
import { MARKER } from './issue'

describe('GhCli', () => {
  const calls: string[][] = []
  const replies: Record<string, string> = {
    'api user --jq .login': 'octocat\n',
    'issue view 7 --json number,title,body,author,labels,state,url,comments': JSON.stringify({
      number: 7, title: 'T', body: 'B', author: { login: 'alice' }, labels: [{ name: 'factory' }],
      state: 'OPEN', url: 'u', comments: [{ author: { login: 'bob' }, body: 'hi', createdAt: 'c' }]
    }),
    'pr view 9 --json state': '{"state":"MERGED"}',
    'pr view 9 --json isDraft': '{"isDraft":true}',
    'pr list --head factory/x --state open --json number,url': '[{"number":9,"url":"p"}]',
    'issue list --label factory --state open --limit 200 --json number,title': '[{"number":7,"title":"T"}]'
  }
  const gh = new GhCli(async (args) => {
    calls.push(args)
    return replies[args.join(' ')] ?? ''
  })

  test('reads', async () => {
    expect(await gh.operator()).toBe('octocat')
    expect(await gh.fetchIssue(7)).toEqual({
      number: 7, title: 'T', body: 'B', author: 'alice', labels: ['factory'], state: 'OPEN', url: 'u',
      comments: [{ author: 'bob', body: 'hi', createdAt: 'c' }]
    })
    expect(await gh.prState(9)).toBe('MERGED')
    expect(await gh.prIsDraft(9)).toBe(true)
    expect(await gh.openPrsForBranch('factory/x')).toEqual([{ number: 9, url: 'p' }])
    expect(await gh.listIssues('factory')).toEqual([{ number: 7, title: 'T' }])
  })

  test('writes: factory comments carry the marker; labels are comma-joined', async () => {
    calls.length = 0
    await gh.comment('pr', 9, 'hello')
    await gh.reply(7, 'my answer')
    await gh.editLabels('issue', 7, { add: ['a'], remove: ['b', 'c'] })
    await gh.prMerge(9, 'squash')
    expect(calls).toEqual([
      ['pr', 'comment', '9', '--body', `${MARKER}\nhello`],
      ['issue', 'comment', '7', '--body', 'my answer'],
      ['issue', 'edit', '7', '--add-label', 'a', '--remove-label', 'b,c'],
      ['pr', 'merge', '9', '--squash']
    ])
  })
})

describe('GitCli against a real repo', () => {
  let repo = ''
  let wt = ''
  let git: GitCli

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-git-'))
    const origin = join(root, 'origin.git')
    repo = join(root, 'repo')
    wt = join(repo, '.worktrees', '001-x')
    const sh = (cwd: string, ...args: string[]) => exec('git', args, { cwd })
    await sh(root, 'init', '-q', '--bare', '-b', 'main', origin)
    await sh(root, 'clone', '-q', origin, repo)
    await sh(repo, 'config', 'user.email', 't@t')
    await sh(repo, 'config', 'user.name', 't')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await sh(repo, 'add', 'a.txt')
    await sh(repo, 'commit', '-qm', 'init')
    await sh(repo, 'push', '-q', 'origin', 'main')
    git = new GitCli(repo)
  })

  test('worktree lifecycle, cleanliness, ahead count, push and remote head', async () => {
    await git.fetch(repo, 'main')
    await git.addWorktree(wt, 'factory/001-x', 'origin/main')
    expect(existsSync(join(wt, 'a.txt'))).toBe(true)
    expect(await git.isClean(wt)).toBe(true)
    expect(await git.commitsAhead(wt, 'origin/main')).toBe(0)
    expect(await git.remoteHead(wt, 'factory/001-x')).toBeNull()

    await writeFile(join(wt, 'a.txt'), 'changed\n')
    expect(await git.isClean(wt)).toBe(false)
    await exec('git', ['commit', '-qam', 'change'], { cwd: wt })
    expect(await git.commitsAhead(wt, 'origin/main')).toBe(1)
    expect(await git.changedFiles(wt, 'origin/main')).toEqual([{ status: 'M', path: 'a.txt' }])

    await git.push(wt, 'factory/001-x')
    expect(await git.remoteHead(wt, 'factory/001-x')).toBe(await git.head(wt))

    await git.removeWorktree(wt)
    await git.deleteBranch('factory/001-x')
    await git.deleteRemoteBranch('factory/001-x')
    expect(existsSync(wt)).toBe(false)
  })

  test('exec failures name the command and its stderr', async () => {
    expect(exec('git', ['rev-parse', 'nope'], { cwd: repo })).rejects.toThrow('`git rev-parse nope` failed')
  })
})
