import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addendumBody } from './agents/prompts'
import { agentsGuideCheck, checksScript, detectChecks, ensureGitignore, mergeMethodCheck, scaffoldAddenda, versionAtLeast } from './setup'

describe('detectChecks', () => {
  test('package.json scripts in lint → typecheck → test → build order, with the lockfile\'s manager', () => {
    const pkg = { scripts: { build: 'nuxt build', test: 'vitest run', lint: 'eslint .', dev: 'nuxt dev' } }
    expect(detectChecks({ packageJson: pkg, files: ['bun.lock'] })).toEqual([
      'bun install --frozen-lockfile', 'bun run lint', 'bun run test', 'bun run build'
    ])
    expect(detectChecks({ packageJson: { scripts: { typecheck: 'tsc' } }, files: ['pnpm-lock.yaml'] })).toEqual([
      'pnpm install --frozen-lockfile', 'pnpm run typecheck'
    ])
    expect(detectChecks({ packageJson: { scripts: { test: 'jest' } }, files: [] })).toEqual(['npm ci', 'npm run test'])
  })

  test('watch-mode test scripts are run once', () => {
    expect(detectChecks({ packageJson: { scripts: { test: 'vitest' } }, files: ['package-lock.json'] }))
      .toContain('npm run test -- --run')
  })

  test('python and go projects', () => {
    expect(detectChecks({ files: ['pyproject.toml'] })).toEqual(['python -m pytest -q'])
    expect(detectChecks({ files: ['go.mod'] })).toEqual(['go vet ./...', 'go test ./...'])
    expect(detectChecks({ files: [] })).toEqual([])
  })
})

describe('checksScript', () => {
  test('strict bash with the commands, or a failing placeholder', () => {
    expect(checksScript(['bun run lint'])).toBe('#!/usr/bin/env bash\n# The repo\'s checks. Exit 0 only when a branch is fit to review.\n# Runs in a job\'s worktree; keep it non-interactive and never rewrite files.\nset -euo pipefail\n\nbun run lint\n')
    expect(checksScript([])).toContain('exit 1')
  })
})

describe('ensureGitignore', () => {
  test('appends only the missing lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-gi-'))
    await writeFile(join(dir, '.gitignore'), 'node_modules\n/.worktrees/\n')
    expect(await ensureGitignore(dir)).toEqual(['/.factory/jobs/', '/.factory/orchestrator.lock'])
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n/.worktrees/\n/.factory/jobs/\n/.factory/orchestrator.lock\n')
    expect(await ensureGitignore(dir)).toEqual([])
  })
})

describe('scaffoldAddenda', () => {
  const FILES = ['approver.append.md', 'intake.append.md', 'reviewer-security.append.md', 'reviewer-ui.append.md', 'reviewer-ux.append.md']

  test('writes five comment-only addenda', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-addenda-'))
    const done = await scaffoldAddenda(dir)
    expect(done).toHaveLength(5)
    expect(done).toContain('wrote .factory/agents/intake.append.md')
    expect((await readdir(join(dir, 'agents'))).sort()).toEqual(FILES)
    for (const f of FILES) {
      const text = await readFile(join(dir, 'agents', f), 'utf8')
      expect(text).toContain('## This project')
      expect(addendumBody(text)).toBeNull()
    }
  })

  test('never overwrites an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-addenda-'))
    await scaffoldAddenda(dir)
    const edited = join(dir, 'agents', 'reviewer-ux.append.md')
    await writeFile(edited, 'Users are nurses on shift.\n')
    await rm(join(dir, 'agents', 'intake.append.md'))
    expect(await scaffoldAddenda(dir)).toEqual(['wrote .factory/agents/intake.append.md'])
    expect(await readFile(edited, 'utf8')).toBe('Users are nurses on shift.\n')
  })
})

describe('versionAtLeast', () => {
  test('compares dotted versions', () => {
    expect(versionAtLeast('2.1.319 (Claude Code)', '2.1.257')).toBe(true)
    expect(versionAtLeast('2.1.9', '2.1.257')).toBe(false)
    expect(versionAtLeast('garbage', '1.0.0')).toBe(false)
  })
})

describe('mergeMethodCheck', () => {
  const FIELDS = { merge: 'allow_merge_commit', squash: 'allow_squash_merge', rebase: 'allow_rebase_merge' } as const
  const methods = ['merge', 'squash', 'rebase'] as const
  const all = (value: boolean) => Object.fromEntries(Object.values(FIELDS).map(f => [f, value]))

  for (const method of methods) {
    test(`${method}: allowed`, () => {
      expect(mergeMethodCheck(method, { ...all(false), [FIELDS[method]]: true }))
        .toEqual({ name: `merge method ${method} allowed`, ok: true, detail: 'ok', optional: false })
    })

    test(`${method}: disallowed names the methods the repo allows`, () => {
      const c = mergeMethodCheck(method, { ...all(true), [FIELDS[method]]: false })
      expect(c.ok).toBe(false)
      expect(c.optional).toBe(false)
      const others = methods.filter(m => m !== method)
      expect(c.detail).toStartWith(`the repo allows only ${others.join(', ')}`)
      expect(c.detail).toContain('mergeMethod')
    })

    test(`${method}: none allowed`, () => {
      const c = mergeMethodCheck(method, all(false))
      expect(c.ok).toBe(false)
      expect(c.optional).toBe(false)
      expect(c.detail).toStartWith('the repo allows no merge method')
    })

    test(`${method}: missing fields are an optional warning`, () => {
      for (const repo of [{ name: 'x' }, { ...all(true), [FIELDS[method]]: 'yes' }, null, 'nope']) {
        const c = mergeMethodCheck(method, repo)
        expect(c).toMatchObject({ name: `merge method ${method} allowed`, ok: false, optional: true })
        expect(c.detail).toContain('couldn\'t read')
      }
    })
  }
})

describe('agentsGuideCheck', () => {
  const NAME = 'AGENTS.md (dev server port)'
  const NO_PORT = 'AGENTS.md doesn\'t say how to start the dev server on a port: UX/UI reviewers will read code only'

  test('none found', () => {
    expect(agentsGuideCheck([{ name: 'AGENTS.md', text: null }, { name: 'CLAUDE.md', text: null }]))
      .toEqual({ name: NAME, ok: false, optional: true, detail: 'no AGENTS.md or CLAUDE.md on origin/<base>' })
  })

  test('AGENTS.md wins over CLAUDE.md', () => {
    expect(agentsGuideCheck([{ name: 'AGENTS.md', text: 'nothing here' }, { name: 'CLAUDE.md', text: 'bun run dev --port 3000' }]))
      .toEqual({ name: NAME, ok: false, optional: true, detail: NO_PORT })
  })

  test('AGENTS.md missing, so CLAUDE.md is used', () => {
    expect(agentsGuideCheck([{ name: 'AGENTS.md', text: null }, { name: 'CLAUDE.md', text: 'bun run dev --port <n>' }]))
      .toEqual({ name: NAME, ok: true, optional: true, detail: 'CLAUDE.md mentions a port' })
  })

  test('a port mentioned or not', () => {
    for (const text of ['bun run dev --port <n>', 'Port 3000 is the default', 'pick free ports']) {
      expect(agentsGuideCheck([{ name: 'AGENTS.md', text }])).toEqual({ name: NAME, ok: true, optional: true, detail: 'AGENTS.md mentions a port' })
    }
    for (const text of ['npm run dev', 'portable code', 'a report', '']) {
      expect(agentsGuideCheck([{ name: 'AGENTS.md', text }])).toEqual({ name: NAME, ok: false, optional: true, detail: NO_PORT })
    }
  })

  test('always optional', () => {
    expect(agentsGuideCheck([]).optional).toBe(true)
    expect(agentsGuideCheck([{ name: 'AGENTS.md', text: 'port' }]).optional).toBe(true)
    expect(agentsGuideCheck([{ name: 'AGENTS.md', text: 'no' }]).optional).toBe(true)
  })
})
