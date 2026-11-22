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
    .replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_\w{20,}|sk-ant-[\w-]{10,})/g, '[redacted]')
}

/** Runs a command without a shell and collects its output. Never throws. */
export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const base = opts.scrub ? scrubbedEnv() : process.env
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...base, ...opts.env }, stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', err => resolve({ code: 127, stdout, stderr: stderr + err.message }))
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
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
