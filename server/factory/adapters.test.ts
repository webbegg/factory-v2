import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    await gh.comment('pr', 9, 'hello from https://bot:hunter2@github.com/o/r')
    await gh.reply(7, 'my answer')
    await gh.editLabels('issue', 7, { add: ['a'], remove: ['b', 'c'] })
    await gh.prMerge(9, 'squash', 'abc123')
    expect(calls).toEqual([
      ['pr', 'comment', '9', '--body', `${MARKER}\nhello from https://***@github.com/o/r`],
      ['issue', 'comment', '7', '--body', 'my answer'],
      ['issue', 'edit', '7', '--add-label', 'a', '--remove-label', 'b,c'],
      ['pr', 'merge', '9', '--squash', '--match-head-commit', 'abc123']
    ])
  })

  test('uploadImages posts each image from a temp file, never on the command line, and removes it', async () => {
    const sent: Array<{ args: string[], bytes: number[] }> = []
    let n = 0
    const up = new GhCli(async (args) => {
      if (args[1] === 'repos/{owner}/{repo}') return '42\n'
      const file = args[args.indexOf('--input') + 1]!
      sent.push({ args, bytes: [...await readFile(file)] })
      return `https://github.com/user-attachments/assets/u${++n}\n`
    })
    const urls = await up.uploadImages([
      { name: 'screenshot-1.png', type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47]) },
      { name: 'screenshot-2.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xFF, 0xD8, 0xFF]) }
    ])
    expect(urls).toEqual(['https://github.com/user-attachments/assets/u1', 'https://github.com/user-attachments/assets/u2'])
    expect(sent.map(s => s.bytes)).toEqual([[0x89, 0x50, 0x4E, 0x47], [0xFF, 0xD8, 0xFF]])
    const file = sent[0]!.args[7]!
    expect(sent[0]!.args).toEqual(['api', '--method', 'POST',
      'https://uploads.github.com/user-attachments/assets?content_type=image%2Fpng&name=screenshot-1.png&repository_id=42',
      '--header', 'Content-Type: application/octet-stream', '--input', file, '--jq', '.url'])
    expect(existsSync(file)).toBe(false)
  })

  test('uploadImages removes its temp files when gh fails', async () => {
    let file = ''
    const up = new GhCli(async (args) => {
      if (args[1] === 'repos/{owner}/{repo}') return '42\n'
      file = args[args.indexOf('--input') + 1]!
      throw new Error('gh: not logged in')
    })
    expect(up.uploadImages([{ name: 'screenshot-1.png', type: 'image/png', bytes: new Uint8Array([1]) }])).rejects.toThrow('not logged in')
    await Bun.sleep(10)
    expect(file).not.toBe('')
    expect(existsSync(file)).toBe(false)
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
    await writeFile(join(repo, 'long.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''))
    await sh(repo, 'add', 'a.txt', 'long.txt')
    await sh(repo, 'commit', '-qm', 'init')
    await sh(repo, 'push', '-q', 'origin', 'main')
    git = new GitCli(repo)
  }, 30_000) // a dozen real git processes; slow machines and busy gates exceed the 5s default

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
    // a rename reports both sides, so moving a file into a protected path is seen
    await exec('git', ['mv', 'long.txt', 'moved.txt'], { cwd: wt })
    await exec('git', ['commit', '-qm', 'rename'], { cwd: wt })
    expect(await git.changedFiles(wt, 'origin/main')).toEqual([
      { status: 'M', path: 'a.txt' }, { status: 'D', path: 'long.txt' }, { status: 'A', path: 'moved.txt' }
    ])

    await git.push(wt, 'factory/001-x')
    expect(await git.remoteHead(wt, 'factory/001-x')).toBe(await git.head(wt))

    await git.removeWorktree(wt)
    await git.deleteBranch('factory/001-x')
    await git.deleteRemoteBranch('factory/001-x')
    expect(existsSync(wt)).toBe(false)
  }, 30_000)

  test('paths git would quote are reported as they are (verify B8)', async () => {
    const wt2 = join(repo, '.worktrees', '002-q')
    await git.addWorktree(wt2, 'factory/002-q', 'origin/main')
    await mkdir(join(wt2, '.github/workflows'), { recursive: true })
    await writeFile(join(wt2, '.github/workflows/dép.yml'), 'x\n')
    await writeFile(join(wt2, 'tab\there.txt'), 'x\n')
    await exec('git', ['add', '.'], { cwd: wt2 })
    await exec('git', ['commit', '-qm', 'odd names'], { cwd: wt2 })
    expect(await git.changedFiles(wt2, 'origin/main')).toEqual([
      { status: 'A', path: '.github/workflows/dép.yml' }, { status: 'A', path: 'tab\there.txt' }
    ])
  }, 30_000)

  test('addWorktree reuses a worktree on its branch, or the branch without one', async () => {
    const wt3 = join(repo, '.worktrees', '003-r')
    await git.addWorktree(wt3, 'factory/003-r', 'origin/main')
    await git.addWorktree(wt3, 'factory/003-r', 'origin/main')
    await writeFile(join(wt3, 'a.txt'), 'kept\n')
    await exec('git', ['commit', '-qam', 'kept'], { cwd: wt3 })
    const head = await git.head(wt3)

    await git.removeWorktree(wt3)
    expect(existsSync(wt3)).toBe(false)
    await git.addWorktree(wt3, 'factory/003-r', 'origin/main')
    expect(await git.head(wt3)).toBe(head)
    expect((await exec('git', ['branch', '--show-current'], { cwd: wt3 })).trim()).toBe('factory/003-r')

    await expect(git.addWorktree(wt3, 'factory/004-s', 'origin/main'))
      .rejects.toThrow(`${wt3} is a worktree on factory/003-r, not factory/004-s`)
    await git.removeWorktree(wt3)
    await git.deleteBranch('factory/003-r')
  }, 30_000)

  test('fetch puts back a remote-tracking ref moved by hand (verify B3)', async () => {
    const real = await exec('git', ['rev-parse', 'origin/main'], { cwd: repo })
    const fake = (await exec('git', ['commit-tree', '-m', 'forged', `${real.trim()}^{tree}`], { cwd: repo })).trim()
    await exec('git', ['update-ref', 'refs/remotes/origin/main', fake], { cwd: repo })
    await git.fetch(repo, 'main')
    expect(await exec('git', ['rev-parse', 'origin/main'], { cwd: repo })).toBe(real)
  }, 30_000)

  test('a tag or branch named origin/main can\'t shadow the remote-tracking ref (verify run 2, B4)', async () => {
    const real = (await exec('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo })).trim()
    const fake = (await exec('git', ['commit-tree', '-m', 'forged', `${real}^{tree}`], { cwd: repo })).trim()
    await exec('git', ['tag', 'origin/main', fake], { cwd: repo })
    try {
      expect((await exec('git', ['rev-parse', 'origin/main'], { cwd: repo })).trim()).toBe(fake)
      expect(await git.show(repo, 'refs/remotes/origin/main', 'a.txt')).toBe('a\n')
    } finally {
      await exec('git', ['tag', '-d', 'origin/main'], { cwd: repo })
    }
  }, 30_000)

  test('show reads a file as committed on a ref, or null', async () => {
    await writeFile(join(repo, 'a.txt'), 'uncommitted\n')
    expect(await git.show(repo, 'origin/main', 'a.txt')).toBe('a\n')
    expect(await git.show(repo, 'origin/main', 'nope.txt')).toBeNull()
  })

  test('exec failures name the command and its stderr', async () => {
    expect(exec('git', ['rev-parse', 'nope'], { cwd: repo })).rejects.toThrow('`git rev-parse nope` failed')
  })
})
