// `factory init` and `factory doctor`: put a project in shape to run the
// factory, and check that it is. Shared by the CLI and the setup screen.
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { defaultConfig, factoryPaths, loadConfig } from './config'
import { run } from './exec'
import { runChecksScript, TAIL } from './gate'
import { Refused } from './machine'
import type { FactoryConfig } from './types'

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

const ADDENDA: Record<string, string> = {
  'intake': 'one line on what the project is for',
  'approver': 'extra items to always escalate',
  'reviewer-security': 'the project\'s hot spots: auth, data rules, payments, webhooks',
  'reviewer-ui': 'where the design tokens and shared components live',
  'reviewer-ux': 'the kinds of users'
}

/**
 * Writes the commented prompt addenda into `<factoryDir>/agents/`, never
 * overwriting. Being only comments, they change no prompt until filled in.
 */
export async function scaffoldAddenda(factoryDir: string): Promise<string[]> {
  const done: string[] = []
  await mkdir(join(factoryDir, 'agents'), { recursive: true })
  for (const [agent, what] of Object.entries(ADDENDA)) {
    const file = join(factoryDir, 'agents', `${agent}.append.md`)
    if (existsSync(file)) continue
    const text = `<!--\n  Added to the built-in ${agent} prompt under "## This project" once this\n`
      + `  file is committed and pushed to the base. Write ${what}.\n-->\n`
    await writeFile(file, text)
    done.push(`wrote .factory/agents/${agent}.append.md`)
  }
  return done
}

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
  done.push(...await scaffoldAddenda(paths.factory))
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
  /** the end of a run's output, for checks that run something (the base checks) */
  tail?: string
}

type MergeMethod = FactoryConfig['mergeMethod']

const MERGE_FIELDS: Record<MergeMethod, string> = {
  merge: 'allow_merge_commit',
  squash: 'allow_squash_merge',
  rebase: 'allow_rebase_merge'
}

/** Does the repo allow `mergeMethod`? `repo` is the `gh api repos/{owner}/{repo}` JSON. */
export function mergeMethodCheck(method: MergeMethod, repo: unknown): DoctorCheck {
  const name = `merge method ${method} allowed`
  const fields = typeof repo === 'object' && repo !== null ? repo as Record<string, unknown> : {}
  const methods = Object.keys(MERGE_FIELDS) as MergeMethod[]
  // GitHub leaves the allow_* fields out without admin access: not knowing isn't a disallowed method
  if (methods.some(m => typeof fields[MERGE_FIELDS[m]] !== 'boolean')) {
    return { name, ok: false, detail: 'couldn\'t read the repo\'s merge settings (they need admin access)', optional: true }
  }
  if (fields[MERGE_FIELDS[method]] === true) return { name, ok: true, detail: 'ok', optional: false }
  const allowed = methods.filter(m => fields[MERGE_FIELDS[m]] === true)
  const which = allowed.length ? `the repo allows only ${allowed.join(', ')}` : 'the repo allows no merge method'
  return { name, ok: false, detail: `${which}: change mergeMethod or the repo's merge settings`, optional: false }
}

/** Does the agents' guide (the first of `files` that exists) say how to start the dev server on a port? */
export function agentsGuideCheck(files: Array<{ name: string, text: string | null }>, base = '<base>'): DoctorCheck {
  const name = 'AGENTS.md (dev server port)'
  const found = files.find(f => f.text !== null)
  if (!found) return { name, ok: false, detail: `no AGENTS.md or CLAUDE.md on origin/${base}`, optional: true }
  if (!/\bports?\b/i.test(found.text!)) {
    return { name, ok: false, detail: `${found.name} doesn't say how to start the dev server on a port: UX/UI reviewers will read code only`, optional: true }
  }
  return { name, ok: true, detail: `${found.name} mentions a port`, optional: true }
}

export interface BaseChecksResult {
  check: DoctorCheck
  /** checks.sh's exit code, null when it didn't run */
  code: number | null
  /** the last TAIL lines of its output */
  tail: string
}

let baseChecksRunning = false

/**
 * Runs `.factory/checks.sh` as committed on origin/<base> in a temporary
 * detached worktree of origin/<base>, the way the gate does. A red base fails
 * every job, so doctor says so before any job starts. Slow: as long as the checks.
 */
export async function baseChecks(repoDir: string, opts: { signal?: AbortSignal } = {}): Promise<BaseChecksResult> {
  if (baseChecksRunning) throw new Refused('checks are already running on the base')
  baseChecksRunning = true
  try {
    const paths = factoryPaths(repoDir)
    if (!existsSync(join(paths.factory, 'config.json'))) {
      return { check: { name: 'checks.sh passes on origin/<base>', ok: false, detail: 'skipped: no .factory/config.json (run factory init)' }, code: null, tail: '' }
    }
    const config = await loadConfig(paths)
    const base = config.baseBranch
    const name = `checks.sh passes on origin/${base}`
    const sh = (args: string[]) => run('git', args, { cwd: repoDir })
    const ref = `refs/remotes/origin/${base}`
    await sh(['fetch', '-q', 'origin', base])
    const script = await sh(['show', `${ref}:.factory/checks.sh`])
    if (script.code !== 0) {
      return { check: { name, ok: false, detail: `skipped: .factory/checks.sh isn't committed on origin/${base}` }, code: null, tail: '' }
    }
    const dir = await mkdtemp(join(tmpdir(), 'factory-base-'))
    const tree = join(dir, 'base')
    try {
      const added = await sh(['worktree', 'add', '--detach', tree, ref])
      if (added.code !== 0) {
        return { check: { name, ok: false, detail: `skipped: couldn't create a worktree of origin/${base}: ${added.stderr.trim().split('\n')[0]}` }, code: null, tail: '' }
      }
      const res = await runChecksScript(script.stdout, tree, config.limits.checksMinutes, opts.signal)
      const detail = res.code === 0
        ? `passed in ${res.seconds}s`
        : res.code === 124
          ? `timed out after ${config.limits.checksMinutes} min`
          : `failed with exit ${res.code} in ${res.seconds}s`
      const tail = res.output.trimEnd().split('\n').slice(-TAIL).join('\n')
      return { check: { name, ok: res.code === 0, detail }, code: res.code, tail }
    } finally {
      await sh(['worktree', 'remove', '--force', tree])
      await rm(dir, { recursive: true, force: true })
      await sh(['worktree', 'prune'])
    }
  } finally {
    baseChecksRunning = false
  }
}

/** what the SDK sandbox needs on each platform it supports */
const SANDBOX_NEEDS: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ['sandbox-exec'], linux: ['bwrap', 'socat'] }

/**
 * Can the agent sandbox start here? Required once it's on: the runner fails
 * closed, so every agent run would fail without it.
 */
export function sandboxCheck(enabled: boolean, platform: NodeJS.Platform, has: (cmd: string) => boolean): DoctorCheck {
  const name = 'agent sandbox'
  if (!enabled) return { name, ok: false, optional: true, detail: 'off: set sandbox.enabled in .factory/config.json to contain agent shells' }
  const needs = SANDBOX_NEEDS[platform]
  if (!needs) return { name, ok: false, optional: false, detail: `not supported on ${platform}: turn sandbox.enabled off` }
  const missing = needs.filter(cmd => !has(cmd))
  return missing.length
    ? { name, ok: false, optional: false, detail: `missing ${missing.join(', ')}: install ${missing.map(c => c === 'bwrap' ? 'bubblewrap' : c).join(', ')} or turn sandbox.enabled off` }
    : { name, ok: true, optional: false, detail: `on (${needs.join(', ')})` }
}

/** agent-browser lets the UX and UI reviewers look at pages, except under the sandbox, where Chrome can't start */
export function browserCheck(version: string | null, sandboxed: boolean): DoctorCheck {
  const name = 'agent-browser (UI reviews)'
  if (sandboxed) return { name, ok: false, optional: true, detail: 'sandbox on: no browser, UX/UI reviewers read the code and curl the dev server' }
  return version === null
    ? { name, ok: false, optional: true, detail: 'not installed: UX/UI reviewers review code only' }
    : { name, ok: true, optional: true, detail: version }
}

const onPath = (cmd: string) => (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(dir, cmd)))

/**
 * Preflight: can the factory run in this project? `baseChecks` also runs
 * checks.sh on origin/<base>, which takes as long as the checks do.
 */
export async function doctor(repoDir: string, opts: { baseChecks?: boolean } = {}): Promise<DoctorCheck[]> {
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
  let config: FactoryConfig | null = null
  let configError = 'run factory init'
  if (existsSync(configPath)) {
    try {
      config = await loadConfig(paths)
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err)
    }
  }
  const hasConfig = config !== null
  add('.factory/config.json', hasConfig, hasConfig ? 'ok' : configError)
  const sandboxed = config?.sandbox.enabled ?? false
  out.push(sandboxCheck(sandboxed, process.platform, onPath))
  if (config) {
    const base = config.baseBranch
    const remote = await sh('git', ['ls-remote', '--exit-code', '--heads', 'origin', base])
    add(`base branch ${base} on origin`, remote.code === 0, remote.code === 0 ? 'ok' : 'missing on origin')
    add('.factory/checks.sh', existsSync(join(paths.factory, 'checks.sh')), 'the gate runs it in every worktree')
    // the gate and prompt overrides read .factory/ from origin/<base>, never the working copy
    await sh('git', ['fetch', '-q', 'origin', base])
    const pushed = await sh('git', ['cat-file', '-e', `refs/remotes/origin/${base}:.factory/checks.sh`])
    add(`checks.sh on origin/${base}`, pushed.code === 0, pushed.code === 0 ? 'ok' : `commit and push .factory/ to ${base}: the gate runs that copy`)
    if (opts.baseChecks) {
      const { check, tail } = await baseChecks(repoDir)
      out.push(tail ? { ...check, tail } : check)
    }
    // a disallowed method would only fail at the final `gh pr merge`
    const repo = await sh('gh', ['api', 'repos/{owner}/{repo}'])
    let settings: unknown
    try {
      settings = repo.code === 0 ? JSON.parse(repo.stdout) : undefined
    } catch {
      settings = undefined
    }
    if (settings === undefined) {
      const why = repo.stderr.trim().split('\n')[0] || 'gh api returned no JSON'
      add(`merge method ${config.mergeMethod} allowed`, false, `couldn't read the repo's merge settings: ${why}`, true)
    } else {
      out.push(mergeMethodCheck(config.mergeMethod, settings))
    }
    // agents read the guide in their worktrees, which are checkouts of origin/<base>
    const guides = await Promise.all(['AGENTS.md', 'CLAUDE.md'].map(async (name) => {
      const res = await sh('git', ['show', `refs/remotes/origin/${base}:${name}`])
      return { name, text: res.code === 0 ? res.stdout : null }
    }))
    out.push(agentsGuideCheck(guides, base))
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
  out.push(browserCheck(browser.code === 0 ? browser.stdout.trim() : null, sandboxed))
  return out
}
