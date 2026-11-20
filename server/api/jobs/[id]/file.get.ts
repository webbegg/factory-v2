import { readJobFile } from '../../../factory/service'

// ?path=round-1/checks.md — a file inside the job folder.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const id = getRouterParam(event, 'id')!
  const path = String(getQuery(event).path ?? '')
  const text = await guarded(() => readJobFile(f.store, id, path))
  if (text === null) throw createError({ statusCode: 404, statusMessage: `${path} not found` })
  return { path, text }
})
