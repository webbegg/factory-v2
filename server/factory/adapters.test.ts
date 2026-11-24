import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  test('prCreate opens a draft from the branch and reads its number from the URL (#49)', async () => {
    const seen: string[][] = []
    const pr = new GhCli(async (args) => {
      seen.push(args)
      return 'https://github.com/o/r/pull/42\n'
    })
    expect(await pr.prCreate({ base: 'main', head: 'factory/001-x', title: 'T', body: 'Closes #1' }))
      .toEqual({ number: 42, url: 'https://github.com/o/r/pull/42' })
    expect(seen).toEqual([['pr', 'create', '--draft', '--base', 'main', '--head', 'factory/001-x', '--title', 'T', '--body', 'Closes #1']])
    // title and body both come from build.md: both redacted
    await pr.prCreate({ base: 'main', head: 'b', title: 'T https://u:pw@github.com/o/r', body: 'B https://u:pw@github.com/o/r' })
    expect(seen[1]!.slice(-3)).toEqual(['T https://***@github.com/o/r', '--body', 'B https://***@github.com/o/r'])
  })

  test('commitChecks reads every page of check runs and statuses and maps their states', async () => {
    const sha = 'f'.repeat(40)
    const seen: string[][] = []
    const runs = (items: object[], total: number) => JSON.stringify({ total, items })
    const ci = new GhCli(async (args) => {
      seen.push(args)
      if (args[1]!.endsWith('/check-runs?per_page=100')) {
        return [
          runs([
            { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/runs/1' },
            { name: 'docs', status: 'completed', conclusion: 'neutral', html_url: null },
            { name: 'e2e', status: 'in_progress', conclusion: null, html_url: null }
          ], 6),
          runs([
            { name: 'lint', status: 'completed', conclusion: 'skipped', html_url: null },
            { name: 'old', status: 'completed', conclusion: 'stale', html_url: null },
            { name: 'deploy', status: 'completed', conclusion: 'timed_out', html_url: 'https://x:secret@ci.example/1' }
          ], 6)
        ].join('\n') + '\n'
      }
      return runs([
        { context: 'ci/a', state: 'success', target_url: 'https://ci.example/a' },
        { context: 'ci/b', state: 'pending', target_url: null },
        { context: 'ci/c', state: 'error', target_url: null },
        { context: 'ci/d', state: 'failure', target_url: null }
      ], 5) + '\n'
    })
    expect(await ci.commitChecks(sha)).toEqual([
      { name: 'build', state: 'success', url: 'https://github.com/o/r/runs/1' },
      { name: 'docs', state: 'success', url: null },
      { name: 'e2e', state: 'pending', url: null },
      { name: 'lint', state: 'success', url: null },
      { name: 'old', state: 'failure', url: null },
      { name: 'deploy', state: 'failure', url: 'https://***@ci.example/1' },
      { name: 'ci/a', state: 'success', url: 'https://ci.example/a' },
      { name: 'ci/b', state: 'pending', url: null },
      { name: 'ci/c', state: 'failure', url: null },
      { name: 'ci/d', state: 'failure', url: null },
      { name: 'commit statuses list incomplete: GitHub returned 4 of 5', state: 'pending', url: null }
    ])
    expect(seen.map(a => a.slice(0, 3))).toEqual([
      ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--paginate'],
      ['api', `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`, '--paginate']
    ])
  })

  test('commitChecks refuses anything but a 40-hex sha without running gh', async () => {
    let ran = false
    const ci = new GhCli(async () => {
      ran = true
      return ''
    })
    for (const bad of ['abc123', `${'a'.repeat(40)}/../x`, `${'g'.repeat(40)}`, '']) {
      await expect(ci.commitChecks(bad)).rejects.toThrow('not a commit sha')
    }
    expect(ran).toBe(false)
  })

  test('prMergeCommit reads the merge commit, then its tree (#75)', async () => {
    const sha = 'd'.repeat(40)
    const tree = 'e'.repeat(40)
    const calls: string[][] = []
    const merged = new GhCli(async (args) => {
      calls.push(args)
      return args[0] === 'pr' ? JSON.stringify({ mergeCommit: { oid: sha } }) : `${tree}\n`
    })
    expect(await merged.prMergeCommit(9)).toEqual({ sha, tree })
    expect(calls).toEqual([
      ['pr', 'view', '9', '--json', 'mergeCommit'],
      ['api', `repos/{owner}/{repo}/git/commits/${sha}`, '--jq', '.tree.sha']
    ])

    const none = new GhCli(async () => JSON.stringify({ mergeCommit: null }))
    expect(await none.prMergeCommit(9)).toBeNull()
  })

  test('prMergeCommit refuses a merge commit or tree that isn\'t a 40-hex sha (#75)', async () => {
    let apiCalls = 0
    const badSha = new GhCli(async (args) => {
      if (args[0] === 'api') apiCalls++
      return JSON.stringify({ mergeCommit: { oid: '../x' } })
    })
    await expect(badSha.prMergeCommit(9)).rejects.toThrow('not a commit sha')
    expect(apiCalls).toBe(0)
    const badTree = new GhCli(async args => args[0] === 'pr' ? JSON.stringify({ mergeCommit: { oid: 'd'.repeat(40) } }) : 'null\n')
    await expect(badTree.prMergeCommit(9)).rejects.toThrow('not a commit sha')
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
    const tree = (await exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: wt })).trim()
    expect(await git.tree(wt, await git.head(wt))).toBe(tree)
    expect(tree).toMatch(/^[0-9a-f]{40}$/)
    // a rename reports both sides, so moving a file into a protected path is seen
    await exec('git', ['mv', 'long.txt', 'moved.txt'], { cwd: wt })
    await exec('git', ['commit', '-qm', 'rename'], { cwd: wt })
    expect(await git.changedFiles(wt, 'origin/main')).toEqual([
      { status: 'M', path: 'a.txt' }, { status: 'D', path: 'long.txt' }, { status: 'A', path: 'moved.txt' }
    ])

    // verify B1: a ref planted as refs/tags/origin/main wins over the short name, never over the full one the factory uses
    const planted = join(repo, '.git', 'refs', 'tags', 'origin', 'main')
    await mkdir(join(planted, '..'), { recursive: true })
    await writeFile(planted, `${await git.head(wt)}\n`)
    await git.fetch(repo, 'main')
    expect(await git.commitsAhead(wt, 'origin/main')).toBe(0)
    expect(await git.commitsAhead(wt, 'refs/remotes/origin/main')).toBe(2)
    expect((await git.changedFiles(wt, 'refs/remotes/origin/main')).map(f => f.path)).toEqual(['a.txt', 'long.txt', 'moved.txt'])
    await rm(planted)

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

  test('a worktree can\'t redirect the factory\'s git to a gitdir it planted, and hooks never run (#49)', async () => {
    const wt5 = join(repo, '.worktrees', '005-h')
    await git.addWorktree(wt5, 'factory/005-h', 'origin/main')
    const marker = join(repo, '..', 'pwned')
    // an agent points the worktree's .git file at a gitdir whose config runs a command on every status
    const evil = join(repo, '..', 'evil.git')
    await exec('git', ['init', '-q', '--bare', evil], { cwd: repo })
    await exec('git', ['config', '--file', join(evil, 'config'), 'core.bare', 'false'], { cwd: repo })
    await exec('git', ['config', '--file', join(evil, 'config'), 'core.fsmonitor', `touch ${marker}`], { cwd: repo })
    const dotGit = join(wt5, '.git')
    const real = await readFile(dotGit, 'utf8')
    await writeFile(dotGit, `gitdir: ${evil}\n`)
    // and a hook the repo's own hooks folder would run on merge
    const hook = join(repo, '.git', 'hooks', 'post-merge')
    await writeFile(hook, `#!/bin/sh\ntouch ${marker}-hook\n`, { mode: 0o755 })
    try {
      expect(await git.isClean(wt5)).toBe(true)
      expect(await git.head(wt5)).toBe((await exec('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo })).trim())
      expect(existsSync(marker)).toBe(false)
      // the base moves, so the merge does something and post-merge would fire
      await exec('git', ['commit', '-q', '--allow-empty', '-m', 'base moved'], { cwd: repo })
      await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repo })
      await git.fetch(repo, 'main')
      expect((await git.merge(wt5, 'origin/main')).ok).toBe(true)
      expect(await git.head(wt5)).toBe((await exec('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: repo })).trim())
      expect(existsSync(`${marker}-hook`)).toBe(false)
    } finally {
      await writeFile(dotGit, real)
      await rm(hook, { force: true })
      await rm(marker, { force: true })
      await rm(`${marker}-hook`, { force: true })
      await git.removeWorktree(wt5)
      await git.deleteBranch('factory/005-h')
    }
  }, 30_000)

  test('commitAll commits everything a sandboxed builder left, and nothing when there is nothing (#49)', async () => {
    const wt6 = join(repo, '.worktrees', '006-c')
    await git.fetch(repo, 'main')
    await git.addWorktree(wt6, 'factory/006-c', 'refs/remotes/origin/main')
    try {
      const before = await git.head(wt6)
      expect(await git.commitAll(wt6, 'nothing')).toEqual({ committed: false })
      await writeFile(join(wt6, 'new.txt'), 'new\n')
      await writeFile(join(wt6, 'a.txt'), 'edited\n')
      expect(await git.commitAll(wt6, 'Add new (round 1)')).toEqual({ committed: true })
      expect(await git.isClean(wt6)).toBe(true)
      expect(await git.head(wt6)).not.toBe(before)
      expect((await exec('git', ['log', '-1', '--format=%s'], { cwd: wt6 })).trim()).toBe('Add new (round 1)')
      expect((await exec('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: wt6 })).trim().split('\n')).toEqual(['a.txt', 'new.txt'])
      // a nested repository would be committed as a gitlink, and git status would then honour its config: refused
      const nested = join(wt6, 'sub')
      await mkdir(nested)
      await exec('git', ['init', '-q'], { cwd: nested })
      await writeFile(join(nested, 'f.txt'), 'f\n')
      await exec('git', ['add', 'f.txt'], { cwd: nested })
      await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'nested'], { cwd: nested })
      // and its config runs a filter on any status that recurses into it (verify run 3, B1)
      const marker = join(wt6, '..', 'pwned-006')
      await exec('git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { cwd: nested })
      await writeFile(join(nested, '.gitattributes'), '* filter=evil\n')
      await writeFile(join(nested, 'f.txt'), 'changed\n')
      const head = await git.head(wt6)
      try {
        for (let i = 0; i < 2; i++) {
          const refused = await git.commitAll(wt6, 'nested')
          expect(refused.committed).toBe(false)
          expect(refused.problem).toContain('sub')
          // unstaged again, so nothing later recurses into it
          expect((await exec('git', ['diff', '--cached', '--name-only'], { cwd: wt6 })).trim()).toBe('')
        }
        await git.isClean(wt6)
        expect(existsSync(marker)).toBe(false)
        expect(await git.head(wt6)).toBe(head)
      } finally {
        await rm(nested, { recursive: true, force: true })
        await rm(marker, { force: true })
      }
    } finally {
      await git.removeWorktree(wt6)
      await git.deleteBranch('factory/006-c')
    }
  }, 30_000)

  test('startMerge leaves conflicts for the builder; commitAll refuses markers, then concludes the merge (#49)', async () => {
    const wt7 = join(repo, '.worktrees', '007-m')
    await git.fetch(repo, 'main')
    await git.addWorktree(wt7, 'factory/007-m', 'refs/remotes/origin/main')
    try {
      await writeFile(join(wt7, 'm.txt'), 'branch side\n')
      await git.commitAll(wt7, 'branch change')
      await writeFile(join(repo, 'm.txt'), 'base side\n')
      await exec('git', ['add', 'm.txt'], { cwd: repo })
      await exec('git', ['commit', '-qm', 'base change'], { cwd: repo })
      await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repo })
      await git.fetch(repo, 'main')

      expect(await git.startMerge(wt7, 'refs/remotes/origin/main')).toEqual({ ok: false, conflicts: ['m.txt'] })
      expect(await readFile(join(wt7, 'm.txt'), 'utf8')).toContain('<<<<<<<')
      const head = await git.head(wt7)
      const refused = await git.commitAll(wt7, 'merge')
      expect(refused.committed).toBe(false)
      expect(refused.problem).toContain('m.txt')
      expect(await git.head(wt7)).toBe(head)

      await writeFile(join(wt7, 'm.txt'), 'both sides\n')
      expect(await git.commitAll(wt7, 'Merge main')).toEqual({ committed: true })
      const parents = (await exec('git', ['rev-list', '--parents', '-1', 'HEAD'], { cwd: wt7 })).trim().split(' ')
      expect(parents.length).toBe(3)
      expect(await git.commitsAhead(wt7, 'refs/remotes/origin/main')).toBe(2)

      // no conflict: merged and committed outright
      await exec('git', ['commit', '-q', '--allow-empty', '-m', 'base moved again'], { cwd: repo })
      await exec('git', ['push', '-q', 'origin', 'main'], { cwd: repo })
      await git.fetch(repo, 'main')
      expect(await git.startMerge(wt7, 'refs/remotes/origin/main')).toEqual({ ok: true, conflicts: [] })
      expect(await git.isClean(wt7)).toBe(true)
    } finally {
      await git.removeWorktree(wt7)
      await git.deleteBranch('factory/007-m')
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
