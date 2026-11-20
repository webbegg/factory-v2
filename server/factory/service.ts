import { existsSync } from 'node:fs'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { SdkRunner } from './agents/runner'
import type { AgentRunner } from './agents/runner'
import { factoryPaths, loadConfig } from './config'
import { Gate } from './gate'
import { GhCli, ghRunner } from './gh'
import { GitCli } from './git'
import { GitHubIssues } from './issue'
import { Machine } from './machine'
import { firstLine } from './markdown'
import { Merger } from './merge'
import { Orchestrator } from './orchestrator'
import type { Ports } from './ports'
import { Queue } from './queue'
import { JobStore } from './store'
import type { FactoryConfig, FactoryPaths } from './types'

export interface Factory {
  paths: FactoryPaths
  config: FactoryConfig
  store: JobStore
  github: GhCli
  ports: Ports
  machine: Machine
  queue: Queue
  gate: Gate
  merger: Merger
  orchestrator: Orchestrator
}

/** Wires the engine for one project checkout. */
export async function createFactory(repo: string, runner: AgentRunner = new SdkRunner()): Promise<Factory> {
  const paths = factoryPaths(resolve(repo))
  const config = await loadConfig(paths)
  const store = new JobStore(paths)
  const github = new GhCli(ghRunner(paths.repo))
  const git = new GitCli(paths.repo)
  const ports: Ports = {
    github,
    git,
    issues: new GitHubIssues(github, store),
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  const machine = new Machine({ paths, config, store, ports })
  const queue = new Queue({ paths, config, store, ports, machine })
  const gate = new Gate({ paths, config, store, ports })
  const merger = new Merger({ config, store, ports, machine, gate })
  const orchestrator = new Orchestrator({ paths, config, store, ports, machine, queue, gate, merger, runner })
  return { paths, config, store, github, ports, machine, queue, gate, merger, orchestrator }
}

// ---- One orchestrator per project ------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes .factory/orchestrator.lock for this process; returns its release. */
export async function acquireLock(paths: FactoryPaths): Promise<() => Promise<void>> {
  const lock = join(paths.factory, 'orchestrator.lock')
  try {
    await writeFile(lock, `${process.pid}\n`, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const pid = Number.parseInt(await readFile(lock, 'utf8'), 10)
    if (Number.isFinite(pid) && alive(pid)) throw new Error(`factory is already running (pid ${pid}) in ${paths.repo}`, { cause: err })
    await writeFile(lock, `${process.pid}\n`)
  }
  return async () => {
    if (existsSync(lock)) await unlink(lock)
  }
}

// ---- Job files for the UI ---------------------------------------------------

export type Tone = 'good' | 'warn' | 'stop' | null

export function tone(first: string): Tone {
  if (/^(VERDICT:\s*PASS|GATE:\s*PASS|APPROVE|STATUS:\s*READY|DECISION:\s*ACCEPT)$/.test(first)) return 'good'
  if (/^(VERDICT:\s*CHANGES|DECISION:\s*NEEDS-INFO)$/.test(first)) return 'warn'
  if (/^(ESCALATE|REJECTED|STATUS:\s*BLOCKED|GATE:\s*FAIL|DECISION:\s*REJECT)$/.test(first)) return 'stop'
  return null
}

const TOP = ['issue.md', 'intake.md', 'spec.md', 'build.md', 'decision.md', 'rejection.md']
const ROUND = ['checks', 'review-code', 'review-security', 'review-ux', 'review-ui', 'merge-checks']

function rank(path: string): [number, number, string] {
  if (TOP.includes(path)) return [0, TOP.indexOf(path), path]
  const m = /^round-(\d+)\/(.+)\.md$/.exec(path)
  if (m) return [2, Number(m[1]) * 10 + ROUND.indexOf(m[2]!), path]
  return [1, 0, path]
}

export interface JobFile {
  path: string
  first: string
  tone: Tone
}

const SAFE_ID = /^[\w.-]+$/

function checkId(id: string) {
  if (!SAFE_ID.test(id) || id.startsWith('.')) throw new Error(`bad job id ${id}`)
}

/** Every .md file of a job (one level of round folders), in reading order. */
export async function jobFiles(store: JobStore, id: string): Promise<JobFile[]> {
  checkId(id)
  const dir = store.dir(id)
  if (!existsSync(dir)) return []
  const paths: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) paths.push(entry.name)
    if (entry.isDirectory() && /^round-\d+$/.test(entry.name)) {
      for (const f of await readdir(join(dir, entry.name))) if (f.endsWith('.md')) paths.push(`${entry.name}/${f}`)
    }
  }
  paths.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2])
  })
  return Promise.all(paths.map(async (path) => {
    const first = firstLine(await store.read(id, path) ?? '')
    return { path, first, tone: tone(first) }
  }))
}

/** A file inside the job folder, or null when it doesn't exist. */
export async function readJobFile(store: JobStore, id: string, rel: string): Promise<string | null> {
  checkId(id)
  const dir = store.dir(id)
  const target = resolve(dir, rel)
  const inside = relative(dir, target)
  if (!inside || inside.startsWith('..') || inside.split(sep).includes('..')) {
    throw new Error(`${rel} is outside the job folder`)
  }
  return store.read(id, inside)
}

// ---- Local-only server ------------------------------------------------------

/** The UI is served on loopback only; anything else is a DNS-rebinding attempt. */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === 'localhost' || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name ?? '')
}
