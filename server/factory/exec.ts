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
}

/** Runs a command without a shell and collects its output. Never throws. */
export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: 'pipe' })
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
    throw new ExecError(`\`${[cmd, ...args].join(' ')}\` failed: ${why}`, res)
  }
  return res.stdout
}
