import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec, redact, run, scrubbedEnv } from './exec'

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('run limits', () => {
  // a command that leaves a grandchild behind, like a dev server started with &
  async function spawnTree(opts: { timeoutMs?: number, signal?: AbortSignal }) {
    const dir = await mkdtemp(join(tmpdir(), 'factory-exec-'))
    const pidFile = join(dir, 'pid')
    const started = performance.now()
    const res = await run('bash', ['-c', `sleep 30 & echo $! > ${pidFile}; sleep 30`], { cwd: dir, ...opts })
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await Bun.sleep(200)
    return { res, pid, ms: performance.now() - started }
  }

  test('a timeout kills the whole process group and says so', async () => {
    const { res, pid, ms } = await spawnTree({ timeoutMs: 300 })
    expect(res.code).toBe(124)
    expect(res.stderr).toContain('timed out after 0.3s')
    expect(ms).toBeLessThan(10_000)
    expect(alive(pid)).toBe(false)
  }, 20_000)

  test('an abort kills the whole process group', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const { res, pid } = await spawnTree({ signal: controller.signal })
    expect(res.code).toBe(130)
    expect(alive(pid)).toBe(false)
  }, 20_000)
})

describe('scrubbedEnv', () => {
  test('drops secret-looking variables and keeps the rest', () => {
    const env = scrubbedEnv({
      PATH: '/bin', HOME: '/h', CI: '1', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'k',
      NPM_TOKEN: 'n', AWS_SECRET_ACCESS_KEY: 'a', DB_PASSWORD: 'p', MY_CREDENTIALS: 'c', SSH_AUTH_SOCK: 's'
    })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', CI: '1' })
  })
})

describe('redact', () => {
  test('hides credentials in URLs and GitHub/Anthropic token shapes', () => {
    expect(redact('fatal: unable to access https://bob:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git'))
      .toBe('fatal: unable to access https://***@github.com/o/r.git')
    expect(redact('token gho_ABCDEFGHIJKLMNOPQRSTUVWX and github_pat_11ABCDEFG_abcdefghijklmnopqrstuvwxyz'))
      .toBe('token [redacted] and [redacted]')
    expect(redact('key sk-ant-api03-abcdefghijklmnop')).toBe('key [redacted]')
    expect(redact('https://github.com/o/r/pull/9 is fine')).toBe('https://github.com/o/r/pull/9 is fine')
  })

  test('exec errors carry redacted output', async () => {
    await expect(exec('bash', ['-c', 'echo "push to https://u:secretpass@example.com failed" >&2; exit 1'], { cwd: '/' }))
      .rejects.toThrow('push to https://***@example.com failed')
  })
})
