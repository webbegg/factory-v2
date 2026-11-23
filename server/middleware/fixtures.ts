import { fixtureMode, fixtureRefusal } from '../factory/service'

// The fixture board shows sample jobs only; nothing it serves may change them
// or reach GitHub, so every API write is refused before any route runs.
export default defineEventHandler((event) => {
  if (!fixtureMode()) return
  const refused = fixtureRefusal({ method: event.method, path: event.path })
  if (refused) throw createError({ statusCode: refused.status, statusMessage: refused.message })
})
