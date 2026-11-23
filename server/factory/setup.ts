// `factory init` and `factory doctor`: put a project in shape to run the
// factory, and check that it is. Shared by the CLI and the setup screen.
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultConfig, factoryPaths } from './config'
import { run } from './exec'

interface ProjectFacts {
  packageJson?: { scripts?: Record<string, string> }
  /** file names at the project root */
  files: string[]
}

const SCRIPT_ORDER = ['lint', 'typecheck', 'test', 'build']

/** Best-guess check commands for a project; the user reviews them before use. */
export function detectChecks({ packageJson, files }: ProjectFacts): string[] {
  const has = (f: string) => files.includes(f)
  if (packageJson) {
    const scripts = packageJson.scripts ?? {}
    const [pm, install] = has('bun.lock') || has('bun.lockb')
      ? ['bun', 'bun install --frozen-lockfile']
      : has('pnpm-lock.yaml')
        ? ['pnpm', 'pnpm install --frozen-lockfile']
        : has('yarn.lock')
          ? ['yarn', 'yarn install --frozen-lockfile']
          : ['npm', 'npm ci']
    const steps = SCRIPT_ORDER.filter(s => scripts[s]).map((s) => {
      const watches = s === 'test' && /\bvitest\b/.test(scripts[s]!) && !/\b(run|--run)\b/.test(scripts[s]!)
      return `${pm} run ${s}${watches ? ' -- --run' : ''}`
    })
    return steps.length ? [install, ...steps] : []
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) return ['python -m pytest -q']
  if (has('go.mod')) return ['go vet ./...', 'go test ./...']
  if (has('Cargo.toml')) return ['cargo clippy -- -D warnings', 'cargo test']
  return []
}

export function checksScript(commands: string[]): string {
  const head = '#!/usr/bin/env bash\n'
    + '# The repo\'s checks. Exit 0 only when a branch is fit to review.\n'
    + '# Runs in a job\'s worktree; keep it non-interactive and never rewrite files.\n'
    + 'set -euo pipefail\n\n'
  if (!commands.length) {
    return head + 'echo ".factory/checks.sh has no checks yet: add this repo\'s lint, typecheck, test and build commands." >&2\nexit 1\n'
  }
  return head + commands.join('\n') + '\n'
}

const IGNORED = ['/.factory/jobs/', '/.factory/orchestrator.lock', '/.worktrees/']

/** Adds the factory's runtime paths to .gitignore; returns the lines it added. */
export async function ensureGitignore(repo: string): Promise<string[]> {
  const path = join(repo, '.gitignore')
  const text = existsSync(path) ? await readFile(path, 'utf8') : ''
  const present = new Set(text.split('\n').map(l => l.trim()))
  const missing = IGNORED.filter(l => !present.has(l))
  if (missing.length) {
    await writeFile(path, text + (text && !text.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
  }
  return missing
}

export function versionAtLeast(version: string, min: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const have = m.slice(1).map(Number)
  const want = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!
  }
  return true
}

async function projectFacts(repo: string): Promise<ProjectFacts> {
  const files = await readdir(repo)
  const pkg = join(repo, 'package.json')
  return { files, packageJson: existsSync(pkg) ? JSON.parse(await readFile(pkg, 'utf8')) : undefined }
}

const LABELS = [
  { name: 'factory', color: '5319E7', description: 'Build this with the software factory' },
  { name: 'factory:needs-info', color: 'FBCA04', description: 'The factory asked the author a question' },
  { name: 'factory:needs-human', color: 'D93F0B', description: 'The factory needs a human decision on the PR' }
]

/**
 * Scaffolds .factory/ (never overwriting), the .gitignore lines and the GitHub
 * labels. Returns what it did, one line each.
 */
export async function init(repoDir: string): Promise<string[]> {
  const paths = factoryPaths(repoDir)
  const done: string[] = []
  await mkdir(paths.factory, { recursive: true })
  const configPath = join(paths.factory, 'config.json')
  if (!existsSync(configPath)) {
    const config = defaultConfig()
    const head = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd: repoDir })
    if (head.code === 0 && head.stdout.trim()) config.baseBranch = head.stdout.trim()
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
    done.push(`wrote .factory/config.json (base branch ${config.baseBranch})`)
  }
  const checksPath = join(paths.factory, 'checks.sh')
  if (!existsSync(checksPath)) {
    const commands = detectChecks(await projectFacts(repoDir))
    await writeFile(checksPath, checksScript(commands))
    await chmod(checksPath, 0o755)
    done.push(commands.length
      ? `wrote .factory/checks.sh: ${commands.join(' && ')} (review it)`
      : 'wrote a placeholder .factory/checks.sh: add your checks')
  }
  const ignored = await ensureGitignore(repoDir)
  if (ignored.length) done.push(`.gitignore += ${ignored.join(' ')}`)
  for (const l of LABELS) {
    const res = await run('gh', ['label', 'create', l.name, '--color', l.color, '--description', l.description, '--force'], { cwd: repoDir })
    done.push(res.code === 0 ? `label ${l.name}` : `label ${l.name} FAILED: ${res.stderr.trim()}`)
  }
  return done
}

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  /** optional checks warn instead of failing */
  optional?: boolean
}

/** Preflight: can the factory run in this project? */
export async function doctor(repoDir: string): Promise<DoctorCheck[]> {
  const paths = factoryPaths(repoDir)
  const out: DoctorCheck[] = []
  const sh = (cmd: string, args: string[]) => run(cmd, args, { cwd: repoDir })
  const add = (name: string, ok: boolean, detail: string, optional = false) => out.push({ name, ok, detail, optional })

  const top = await sh('git', ['rev-parse', '--show-toplevel'])
  add('git repository', top.code === 0, top.code === 0 ? top.stdout.trim() : 'not a git repository')
  const origin = await sh('git', ['remote', 'get-url', 'origin'])
  add('origin on GitHub', origin.code === 0 && origin.stdout.includes('github.com'), origin.stdout.trim() || 'no origin remote')
  const auth = await sh('gh', ['auth', 'status'])
  add('gh authenticated', auth.code === 0, auth.code === 0 ? 'ok' : (auth.stderr.trim().split('\n')[0] ?? 'gh auth login'))
  const claude = await sh('claude', ['--version'])
  add('claude ≥ 2.1.257', claude.code === 0 && versionAtLeast(claude.stdout, '2.1.257'), claude.stdout.trim() || 'claude not found')

  const configPath = join(paths.factory, 'config.json')
  const hasConfig = existsSync(configPath)
  add('.factory/config.json', hasConfig, hasConfig ? 'ok' : 'run factory init')
  if (hasConfig) {
    const base = (JSON.parse(await readFile(configPath, 'utf8')) as { baseBranch?: string }).baseBranch ?? 'main'
    const remote = await sh('git', ['ls-remote', '--exit-code', '--heads', 'origin', base])
    add(`base branch ${base} on origin`, remote.code === 0, remote.code === 0 ? 'ok' : 'missing on origin')
    add('.factory/checks.sh', existsSync(join(paths.factory, 'checks.sh')), 'the gate runs it in every worktree')
    // the gate and prompt overrides read .factory/ from origin/<base>, never the working copy
    await sh('git', ['fetch', '-q', 'origin', base])
    const pushed = await sh('git', ['cat-file', '-e', `refs/remotes/origin/${base}:.factory/checks.sh`])
    add(`checks.sh on origin/${base}`, pushed.code === 0, pushed.code === 0 ? 'ok' : `commit and push .factory/ to ${base}: the gate runs that copy`)
  } else {
    add('.factory/checks.sh', existsSync(join(paths.factory, 'checks.sh')), 'the gate runs it in every worktree')
  }
  const labels = await sh('gh', ['label', 'list', '--search', 'factory', '--json', 'name', '--jq', '.[].name'])
  const names = new Set(labels.stdout.split('\n').map(s => s.trim()))
  const missing = LABELS.map(l => l.name).filter(n => !names.has(n))
  add('GitHub labels', labels.code === 0 && !missing.length, missing.length ? `missing: ${missing.join(', ')}` : 'ok')
  const gi = existsSync(join(repoDir, '.gitignore')) ? await readFile(join(repoDir, '.gitignore'), 'utf8') : ''
  const unignored = IGNORED.filter(l => !gi.split('\n').map(x => x.trim()).includes(l))
  add('.gitignore', !unignored.length, unignored.length ? `missing: ${unignored.join(' ')}` : 'ok')
  const browser = await sh('agent-browser', ['--version'])
  add('agent-browser (UI reviews)', browser.code === 0, browser.code === 0 ? browser.stdout.trim() : 'not installed: UX/UI reviewers review code only', true)
  return out
}
