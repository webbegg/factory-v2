import { describe, expect, test } from 'bun:test'
import { exec, redact, scrubbedEnv } from './exec'

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
