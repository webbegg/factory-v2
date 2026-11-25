import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from './exec'
import { runChecksScript } from './gate'
import { requestRefusal } from './service'
import { SESSION_REQUIRED, sessionCookieName, sessionToken, tokenLanding, tokenMatches } from './session'
import { realSandbox } from './testing'

describe('session token (#85)', () => {
  test('one per process, 43 base64url chars, shared through globalThis', () => {
    const t = sessionToken()
    expect(t).toMatch(/^[\w-]{43}$/)
    expect(sessionToken()).toBe(t)
    expect((globalThis as Record<symbol, { token?: string }>)[Symbol.for('factory.session')]?.token).toBe(t)
  })

  test('tokenMatches: equal only; different, different-length and missing values are false', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
  })

  test('sessionCookieName carries the Host port', () => {
    expect(sessionCookieName('localhost:5139')).toBe('factory_session_5139')
    expect(sessionCookieName('localhost:4400')).not.toBe(sessionCookieName('localhost:5139'))
    expect(sessionCookieName('[::1]:4400')).toBe('factory_session_4400')
    expect(sessionCookieName('localhost')).toBe('factory_session_80')
    expect(sessionCookieName(undefined)).toBe('factory_session_80')
  })

  test('never in process.env, nor in what checks.sh receives', async () => {
    const t = sessionToken()
    for (const v of Object.values(process.env)) expect(v ?? '').not.toContain(t)
    const dir = await mkdtemp(join(tmpdir(), 'session-env-'))
    try {
      const res = await runChecksScript('env', dir, 1)
      expect(res.code).toBe(0)
      expect(res.output).toContain('CI=1')
      expect(res.output).not.toContain(t)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('tokenLanding (#85)', () => {
  const token = 'x'.repeat(43)
  const host = 'localhost:5139'

  test('a matching token sets the cookie and redirects without it, keeping the rest of the query', () => {
    const res = tokenLanding({ method: 'GET', path: `/?job=001-a&token=${token}&x=1`, host }, token)
    expect(res).toEqual({ location: '/?job=001-a&x=1', cookie: `factory_session_5139=${token}; HttpOnly; SameSite=Strict; Path=/` })
    expect(tokenLanding({ method: 'GET', path: `/?token=${token}`, host }, token)?.location).toBe('/')
  })

  test('a wrong token redirects with no cookie and no token', () => {
    const res = tokenLanding({ method: 'GET', path: '/inbox?token=wrong', host }, token)
    expect(res).toEqual({ location: '/inbox', cookie: null })
    expect(res?.location).not.toContain('wrong')
    expect(res?.location).not.toContain(token)
    expect(SESSION_REQUIRED).not.toContain(token)
  })

  test('requests without a token, API paths and other methods pass through', () => {
    expect(tokenLanding({ method: 'GET', path: '/?job=001-a', host }, token)).toBeNull()
    expect(tokenLanding({ method: 'GET', path: `/api/state?token=${token}`, host }, token)).toBeNull()
    expect(tokenLanding({ method: 'POST', path: `/?token=${token}`, host }, token)).toBeNull()
  })

  test('the redirect stays on this site', () => {
    expect(tokenLanding({ method: 'GET', path: '/.//evil.com/?token=x', host }, token)?.location).toBe('/evil.com/')
  })
})

describe.skipIf(!realSandbox)('the API refuses sandboxed checks.sh over localhost, for real (#85)', () => {
  let root = ''
  afterAll(() => rm(root, { recursive: true, force: true }))

  test('a curl from checks.sh gets a 403; the board\'s cookie gets through', async () => {
    const token = sessionToken()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        const host = req.headers.get('host') ?? undefined
        const cookie = req.headers.get('cookie')?.split(/;\s*/).find(c => c.startsWith(`${sessionCookieName(host)}=`))
        const refused = requestRefusal({
          host,
          origin: req.headers.get('origin') ?? undefined,
          fetchSite: req.headers.get('sec-fetch-site') ?? undefined,
          method: req.method,
          path: url.pathname,
          contentType: req.headers.get('content-type') ?? undefined,
          session: cookie?.slice(cookie.indexOf('=') + 1)
        }, token)
        return refused ? new Response(refused.message, { status: refused.status }) : Response.json({ ok: true })
      }
    })
    try {
      root = await mkdtemp(join(tmpdir(), 'session-sbx-'))
      const repo = join(root, 'repo')
      await exec('git', ['init', '-q', '-b', 'main', repo], { cwd: root })
      await exec('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
      await exec('git', ['worktree', 'add', '-q', '.worktrees/001-x', '-b', 'factory/001-x'], { cwd: repo })
      const wt = join(repo, '.worktrees', '001-x')
      const url = `http://127.0.0.1:${server.port}/api/settings/config`
      const script = `echo "CODE[$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' ${url})]"`
      const res = await runChecksScript(script, wt, 2, undefined, { gitDir: join(repo, '.git'), domains: [] })
      expect(res.output).toContain('CODE[403]')

      // the control: the board's own cookie, from outside the sandbox
      const ok = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': `${sessionCookieName(`127.0.0.1:${server.port}`)}=${token}` },
        body: '{}'
      })
      expect(ok.status).not.toBe(403)
    } finally {
      void server.stop(true)
    }
  }, 60_000)
})
