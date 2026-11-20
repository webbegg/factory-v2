import { isLocalHost } from '../factory/service'

// The factory acts with the user's git, gh and Claude credentials, so only
// pages served from loopback may call it: foreign Host headers (DNS
// rebinding) are refused, and writes must be JSON, which a cross-site form
// can't send without a CORS preflight this server never grants.
export default defineEventHandler((event) => {
  if (!isLocalHost(getRequestHeader(event, 'host'))) {
    throw createError({ statusCode: 403, statusMessage: 'factory UI is local only' })
  }
  const method = event.method
  if (method !== 'GET' && method !== 'HEAD' && event.path.startsWith('/api/')) {
    const type = getRequestHeader(event, 'content-type') ?? ''
    if (!type.startsWith('application/json')) {
      throw createError({ statusCode: 415, statusMessage: 'send application/json' })
    }
  }
})
