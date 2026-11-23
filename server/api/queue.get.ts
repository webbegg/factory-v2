export default defineEventHandler(async () => {
  // the fixture board has no GitHub to ask
  if (useFixtures()) return []
  const f = await useFactory()
  return guarded(() => f.queue.rows())
})
