export default defineEventHandler(async () => {
  const f = await useFactory()
  return guarded(() => f.queue.rows())
})
