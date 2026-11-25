import { fixtureMode } from '../factory/service'
import { sessionToken, tokenLanding } from '../factory/session'

// Opening the URL `factory` printed trades its token for the session cookie
// and drops it from the address bar. Runs after local-only.ts (filename order),
// so a foreign Host is refused first.
export default defineEventHandler((event) => {
  if (fixtureMode()) return
  const landing = tokenLanding({ method: event.method, path: event.path, host: getRequestHeader(event, 'host') }, sessionToken())
  if (!landing) return
  if (landing.cookie) appendResponseHeader(event, 'set-cookie', landing.cookie)
  return sendRedirect(event, landing.location, 302)
})
