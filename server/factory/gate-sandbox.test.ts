import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from './exec'
import { runChecksScript } from './gate'
import { gateCacheDir, gateSandboxConfig } from './gate-sandbox'
import { realSandbox } from './testing'

describe('gateSandboxConfig (#68)', () => {
  test('writes: the worktree, the run folder and its cache; never the git dir or the .git file', () => {
    const c = gateSandboxConfig('/r/.worktrees/001-x', '/t/run', { gitDir: '/r/.git', domains: ['pypi.org'] })
    expect(c.filesystem.allowWrite).toEqual(['/r/.worktrees/001-x', '/t/run', gateCacheDir('/r/.worktrees/001-x')])
    expect(c.filesystem.denyWrite).toEqual(['/r/.worktrees/001-x/.git', '/r/.git'])
    expect(c.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.ssh', '~/.config/gh', '~/.git-credentials', '~/.aws']))
    // Claude Code's OAuth credentials (Linux) and config, and the factory's own state
    expect(c.filesystem.denyRead).toEqual(expect.arrayContaining(['~/.claude/.credentials.json', '~/.claude.json', '~/.factory']))
    expect(c.network).toEqual({ allowedDomains: ['registry.npmjs.org', 'pypi.org'], deniedDomains: [], strictAllowlist: true, allowLocalBinding: true })
  })

  test('each worktree gets its own cache, outside the repo', () => {
    expect(gateCacheDir('/r/.worktrees/001-x')).not.toBe(gateCacheDir('/r/.worktrees/002-y'))
    expect(gateCacheDir('/r/.worktrees/001-x').startsWith('/r/')).toBe(false)
  })
})

describe.skipIf(!realSandbox)('runChecksScript under the sandbox, for real (#68)', () => {
  let root = ''
  afterAll(() => rm(root, { recursive: true, force: true }))

  test('checks.sh writes its worktree, and nothing outside it; no git dir, no network but the allowed', async () => {
    // left unresolved on purpose: on macOS the temp dir is under /var, a link to /private/var
    root = await mkdtemp(join(tmpdir(), 'gate-sbx-'))
    expect(realpathSync(root) === root).toBe(process.platform !== 'darwin')
    const repo = join(root, 'repo')
    const outside = join(root, 'outside')
    await mkdir(repo)
    await mkdir(outside)
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    await exec('git', ['worktree', 'add', '-q', '.worktrees/001-x', '-b', 'factory/001-x'], { cwd: repo })
    const wt = join(repo, '.worktrees', '001-x')
    const script = [
      'echo ok > made.txt',
      'echo tmp > "$TMPDIR/t" && echo "TMP_OK"',
      'echo c > "$BUN_INSTALL_CACHE_DIR.probe" && echo "CACHE_OK"',
      `touch ${repo}/.git/planted || echo "GITDIR_DENIED"`,
      `echo x > .git || echo "DOTGIT_DENIED"`,
      `touch ${outside}/planted || echo "OUTSIDE_DENIED"`,
      'curl -s -m 5 -o /dev/null https://example.com/ || echo "NET_DENIED"',
      'echo "ENV[${GH_TOKEN:-}${ANTHROPIC_API_KEY:-}]"',
      'git status --short && echo "GIT_READS"'
    ].join('\n')
    const before = { gh: process.env.GH_TOKEN, key: process.env.ANTHROPIC_API_KEY }
    process.env.GH_TOKEN = 'ghp_fake'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake'
    try {
      const res = await runChecksScript(script, wt, 2, undefined, { gitDir: join(repo, '.git'), domains: [] })
      expect(res.code).toBe(0)
      for (const word of ['TMP_OK', 'CACHE_OK', 'GITDIR_DENIED', 'DOTGIT_DENIED', 'OUTSIDE_DENIED', 'NET_DENIED', 'ENV[]', 'GIT_READS']) expect(res.output).toContain(word)
      expect(existsSync(join(wt, 'made.txt'))).toBe(true)
      expect(existsSync(join(repo, '.git', 'planted'))).toBe(false)
      expect(existsSync(join(outside, 'planted'))).toBe(false)

      // the control: without the sandbox the same script writes outside
      const open = await runChecksScript(`touch ${outside}/planted`, wt, 1)
      expect(open.code).toBe(0)
      expect(existsSync(join(outside, 'planted'))).toBe(true)
    } finally {
      process.env.GH_TOKEN = before.gh
      process.env.ANTHROPIC_API_KEY = before.key
      if (before.gh === undefined) delete process.env.GH_TOKEN
      if (before.key === undefined) delete process.env.ANTHROPIC_API_KEY
    }
  }, 60_000)
})
