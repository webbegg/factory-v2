// { issue?: number } — one issue now, or drain the whole queue.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const body = await readBody<{ issue?: unknown }>(event)
  if (body?.issue !== undefined) {
    const issue = Number(body.issue)
    if (!Number.isInteger(issue) || issue < 1) throw createError({ statusCode: 400, statusMessage: 'issue must be a number' })
    return guarded(async () => ({ job: await f.orchestrator.runIssue(issue) }))
  }
  await guarded(() => f.orchestrator.drain())
  return { draining: true }
})
