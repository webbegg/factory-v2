import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { FactoryEvent } from './orchestrator'
import { acquireLock, createFactory } from './service'
import { doctor, init } from './setup'
import type { Job } from './types'
import { run } from './exec'

const USAGE = `factory — issue-to-PR software factory for the project in the current directory

  factory [ui] [--port <n>] [--no-open]   start the board (default port 4400)
  factory run [<issue>]                   headless: drain the queue, or run one issue, then exit
  factory status                          jobs, stages, PRs and cost
  factory init                            scaffold .factory/, .gitignore lines and GitHub labels
  factory doctor                          check that this project can run the factory
  factory --version | -v                  print the factory version
`

function elapsed(job: Job): string {
  const end = job.ended ? Date.parse(job.ended) : Date.now()
  const min = Math.max(0, Math.floor((end - Date.parse(job.started)) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

export function table(jobs: Job[]): string {
  const rows = [['job', 'issue', 'stage', 'round', 'pr', 'cost', 'time']]
  for (const j of jobs) {
    rows.push([j.id, `#${j.issue}`, j.stage, String(j.round), j.pr ? `#${j.pr}` : '-', `$${j.costUsd.toFixed(2)}`, elapsed(j)])
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  const lines = rows.map(r => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd())
  const total = jobs.reduce((a, j) => a + j.costUsd, 0)
  return `${lines.join('\n')}\ntotal $${total.toFixed(2)} (API-equivalent estimate, factory agents only)`
}

function printEvent(e: FactoryEvent) {
  if (e.type === 'log') console.log(e.message)
  else if (e.type === 'error') console.error(`${e.jobId}: ERROR ${e.message}`)
  else if (e.type === 'agent' && e.event.kind === 'tool') console.log(`  ${e.jobId} ${e.agent}: ${e.event.text}`)
  else if (e.type === 'job') console.log(`${e.job.id} #${e.job.issue}: ${e.job.stage} (round ${e.job.round})`)
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// The factory's own package.json, never the project's in repo / cwd
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return (JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as { version: string }).version
}

async function ui(repo: string, args: string[]) {
  const here = dirname(fileURLToPath(import.meta.url))
  // bin/ and .output/ sit at the package root; this file is in server/factory/ when run from source
  const candidates = [resolve(here, '../../.output/server/index.mjs'), resolve(here, '../.output/server/index.mjs')]
  const entry = candidates.find(p => existsSync(p))
  if (!entry) throw new Error('the UI is not built: run `bun run build` in the factory-v2 package')
  const port = flag(args, '--port') ?? process.env.PORT ?? '4400'
  process.env.FACTORY_PROJECT = repo
  process.env.NITRO_HOST = '127.0.0.1'
  process.env.NITRO_PORT = port
  await import(entry)
  const url = `http://localhost:${port}/`
  console.log(`factory board for ${repo}: ${url}`)
  if (!args.includes('--no-open')) {
    await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { cwd: repo })
  }
}

async function headless(repo: string, issue?: string) {
  const f = await createFactory(repo)
  const release = await acquireLock(f.paths)
  try {
    f.orchestrator.on('event', printEvent)
    if (issue) await f.orchestrator.runIssue(Number(issue))
    else await f.orchestrator.drain()
    await f.orchestrator.idle()
    console.log(`\n${table(await f.store.list())}`)
    const waiting = (await f.store.list()).filter(j => j.stage === 'needs-human' || j.stage === 'needs-info')
    for (const j of waiting) {
      console.log(j.stage === 'needs-human'
        ? `waiting on you: ${j.id} — merge PR #${j.pr} to approve, or give feedback on the board`
        : `waiting on the author: ${j.id} (issue #${j.issue})`)
    }
    if (f.orchestrator.errors.size) process.exitCode = 1
  } finally {
    await release()
  }
}

export async function main(argv: string[], repo = process.cwd()): Promise<void> {
  const [cmd = 'ui', ...args] = argv
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(USAGE)
  } else if (cmd === '--version' || cmd === '-v') {
    console.log(version())
  } else if (cmd === 'ui' || cmd.startsWith('--')) {
    await ui(repo, cmd.startsWith('--') ? argv : args)
  } else if (cmd === 'run') {
    if (args[0] && !/^\d+$/.test(args[0])) throw new Error('usage: factory run [<issue number>]')
    await headless(repo, args[0])
  } else if (cmd === 'status') {
    const f = await createFactory(repo)
    console.log(table(await f.store.list()))
  } else if (cmd === 'init') {
    for (const line of await init(repo)) console.log(`- ${line}`)
    console.log('\nNext: review .factory/checks.sh, then `factory doctor`.')
  } else if (cmd === 'doctor') {
    let failed = false
    for (const c of await doctor(repo)) {
      const mark = c.ok ? 'ok  ' : c.optional ? 'warn' : 'FAIL'
      if (!c.ok && !c.optional) failed = true
      console.log(`${mark}  ${c.name}: ${c.detail}`)
    }
    if (failed) process.exitCode = 1
  } else {
    throw new Error(`unknown command ${cmd}\n\n${USAGE}`)
  }
}
