import { randomBytes, timingSafeEqual } from 'node:crypto'

export { SESSION_REQUIRED } from './types'

// The CLI's modules and the bundled Nitro server it imports are two module
// graphs in one process, so the token sits on globalThis, never in process.env,
// which every agent and checks.sh inherit.
const SLOT = Symbol.for('factory.session')

interface Slot {
  token?: string
  /** set by `factory ui`, which prints the board URL itself */
  announced?: boolean
}

function slot(): Slot {
  const g = globalThis as { [SLOT]?: Slot }
  return g[SLOT] ??= {}
}

/** This process's API session token, created on the first call. */
export function sessionToken(): string {
  const s = slot()
  return s.token ??= randomBytes(32).toString('base64url')
}

/** Marks the board URL as printed by the CLI, so the dev-server plugin stays quiet. */
export function announceBoardUrl(): void {
  slot().announced = true
}

export function boardUrlAnnounced(): boolean {
  return slot().announced === true
}

/** Constant-time comparison; a missing or different-length value is false. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Cookies ignore ports, so the name carries it: two boards keep their own cookie. */
export function sessionCookieName(host: string | undefined): string {
  const port = host?.match(/:(\d+)$/)?.[1] ?? '80'
  return `factory_session_${port}`
}

/**
 * The answer to opening the printed `/?token=<t>` URL, or null for any other
 * request: a redirect to the same page without the token, which sets the
 * session cookie only when the token matches.
 */
export function tokenLanding(r: { method: string, path: string, host?: string }, token: string): { location: string, cookie: string | null } | null {
  if (r.method !== 'GET' || r.path.startsWith('/api/')) return null
  const url = new URL(r.path, 'http://localhost')
  if (!url.searchParams.has('token')) return null
  const given = url.searchParams.get('token') ?? undefined
  url.searchParams.delete('token')
  // one leading slash: `//host` would be a redirect to another site
  const location = `/${url.pathname.replace(/^\/+/, '')}${url.search}`
  const cookie = tokenMatches(given, token)
    ? `${sessionCookieName(r.host)}=${token}; HttpOnly; SameSite=Strict; Path=/`
    : null
  return { location, cookie }
}
