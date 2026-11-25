import { fixtureMode, requestRefusal } from '../factory/service'
import { sessionCookieName, sessionToken } from '../factory/session'

// The factory acts with the user's git, gh and Claude credentials, so only
// the board's own pages may call its API; `requestRefusal` says what is refused.
export default defineEventHandler((event) => {
  const host = getRequestHeader(event, 'host')
  const refused = requestRefusal({
    host,
    origin: getRequestHeader(event, 'origin'),
    fetchSite: getRequestHeader(event, 'sec-fetch-site'),
    method: event.method,
    path: event.path,
    contentType: getRequestHeader(event, 'content-type'),
    session: getCookie(event, sessionCookieName(host))
  }, fixtureMode() ? null : sessionToken())
  if (refused) throw createError({ statusCode: refused.status, statusMessage: refused.message })
})
