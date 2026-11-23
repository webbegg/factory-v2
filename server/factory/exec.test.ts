import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
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
  async function spawnTree(opts: { timeoutMs?: number, abort?: AbortController }) {
    const dir = await mkdtemp(join(tmpdir(), 'factory-exec-'))
    const pidFile = join(dir, 'pid')
    const started = performance.now()
    const running = run('bash', ['-c', `sleep 30 & echo $! > ${pidFile}.tmp && mv ${pidFile}.tmp ${pidFile}; sleep 30`],
      { cwd: dir, timeoutMs: opts.timeoutMs, signal: opts.abort?.signal })
    if (opts.abort) {
      // abort once the tree exists, however slow the host is to start it
      while (!existsSync(pidFile)) await Bun.sleep(20)
      opts.abort.abort()
    }
    const res = await running
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await Bun.sleep(200)
    return { res, pid, ms: performance.now() - started }
  }

  test('a timeout kills the whole process group and says so', async () => {
    // long enough for a loaded host to start the tree, far below the 30s it would run
    const { res, pid, ms } = await spawnTree({ timeoutMs: 3000 })
    expect(res.code).toBe(124)
    expect(res.stderr).toContain('timed out after 3s')
    expect(ms).toBeLessThan(15_000)
    expect(alive(pid)).toBe(false)
  }, 20_000)

  test('an abort kills the whole process group', async () => {
    const { res, pid } = await spawnTree({ abort: new AbortController() })
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

  test('a long run of word characters is redacted in linear time (review R1-004)', () => {
    const started = performance.now()
    redact('a'.repeat(200_000))
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('exec errors carry redacted output', async () => {
    await expect(exec('bash', ['-c', 'echo "push to https://u:secretpass@example.com failed" >&2; exit 1'], { cwd: '/' }))
      .rejects.toThrow('push to https://***@example.com failed')
  })
})
