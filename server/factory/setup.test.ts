import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checksScript, detectChecks, ensureGitignore, versionAtLeast } from './setup'

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

describe('versionAtLeast', () => {
  test('compares dotted versions', () => {
    expect(versionAtLeast('2.1.319 (Claude Code)', '2.1.257')).toBe(true)
    expect(versionAtLeast('2.1.9', '2.1.257')).toBe(false)
    expect(versionAtLeast('garbage', '1.0.0')).toBe(false)
  })
})
