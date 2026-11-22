import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd: string
  input?: string
  env?: Record<string, string | undefined>
  /** start from `scrubbedEnv()` instead of the whole process environment */
  scrub?: boolean
  /** kill the command and everything it started after this long; exit code 124 */
  timeoutMs?: number
  /** kill the command and everything it started on abort; exit code 130 */
  signal?: AbortSignal
}

/** process groups still running; a factory that exits ends them, since a detached group would outlive it */
const live = new Set<number>()
process.once('exit', () => {
  for (const pid of live) killGroup(pid, false)
})

/** SIGTERM to the process group, then (`force`) SIGKILL to whatever ignores it. */
function killGroup(pid: number | undefined, force = true) {
  if (!pid) return
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      // already gone
    }
  }
  send('SIGTERM')
  if (force) setTimeout(() => send('SIGKILL'), 2000).unref()
}

const SECRET_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE_KEY|CREDENTIAL|(^|_)AUTH(_|$)/i

/**
 * The environment minus anything named like a secret. Branch code (install
 * scripts, tests) runs under it, so it never sees the factory's GitHub or
 * Anthropic credentials.
 */
export function scrubbedEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(source)
    .filter((e): e is [string, string] => e[1] !== undefined && !SECRET_NAME.test(e[0])))
}

/** Text with credentials in URLs and GitHub/Anthropic token shapes masked, for comments, logs and errors. */
export function redact(text: string): string {
  return text
    // the lookbehind starts a scheme only at a word's start, keeping this linear on long word runs
    .replace(/(?<![\w+.-])([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{20,}|sk-ant-[\w-]{10,})/g, '[redacted]')
}

/**
 * Runs a command without a shell and collects its output. Never throws. The
 * command leads its own process group, so a timeout, an abort, or its own exit
 * also ends what it left running (test watchers, dev servers started with `&`).
 */
export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const base = opts.scrub ? scrubbedEnv() : process.env
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...base, ...opts.env }, stdio: 'pipe', detached: true })
    if (child.pid) live.add(child.pid)
    let stdout = ''
    let stderr = ''
    let stopped: { code: number, why: string } | null = null
    const stop = (code: number, why: string) => {
      stopped ??= { code, why }
      killGroup(child.pid)
    }
    const timer = opts.timeoutMs ? setTimeout(() => stop(124, `timed out after ${opts.timeoutMs! / 1000}s`), opts.timeoutMs) : null
    const onAbort = () => stop(130, 'cancelled')
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (res: ExecResult) => {
      if (child.pid) live.delete(child.pid)
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(stopped ? { ...res, code: stopped.code, stderr: `${res.stderr}\n[factory] ${cmd} ${stopped.why}\n` } : res)
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    // leftovers hold the output pipes open, so 'close' would wait for them
    child.on('exit', () => killGroup(child.pid, false))
    child.on('error', err => done({ code: 127, stdout, stderr: stderr + err.message }))
    child.on('close', code => done({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(opts.input ?? '')
  })
}

export class ExecError extends Error {
  override name = 'ExecError'
  constructor(message: string, public result: ExecResult) {
    super(message)
  }
}

/** Like `run`, but throws when the command exits non-zero. Returns stdout. */
export async function exec(cmd: string, args: string[], opts: ExecOptions): Promise<string> {
  const res = await run(cmd, args, opts)
  if (res.code !== 0) {
    const why = (res.stderr || res.stdout).trim()
    throw new ExecError(redact(`\`${[cmd, ...args].join(' ')}\` failed: ${why}`), res)
  }
  return res.stdout
}
