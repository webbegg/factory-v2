import { requestRefusal } from '../factory/service'

// The factory acts with the user's git, gh and Claude credentials, so only
// the board's own pages may call its API; `requestRefusal` says what is refused.
export default defineEventHandler((event) => {
  const refused = requestRefusal({
    host: getRequestHeader(event, 'host'),
    origin: getRequestHeader(event, 'origin'),
    fetchSite: getRequestHeader(event, 'sec-fetch-site'),
    method: event.method,
    path: event.path,
    contentType: getRequestHeader(event, 'content-type')
  })
  if (refused) throw createError({ statusCode: refused.status, statusMessage: refused.message })
})
