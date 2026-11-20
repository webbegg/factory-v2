// File a new request on the queue: { title, text, run?: boolean }.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const title = await readText(event, 'title')
  const text = await readText(event)
  const { run } = await readBody<{ run?: boolean }>(event)
  return guarded(async () => {
    const issue = await f.github.createIssue(title.trim(), text.trim(), f.config.labels.queue)
    const { job, queued } = run ? await f.orchestrator.runIssue(issue) : { job: null, queued: false }
    return { issue, job, queued }
  })
})
