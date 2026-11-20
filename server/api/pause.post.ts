export default defineEventHandler(async () => {
  const f = await useFactory()
  f.orchestrator.pause()
  return { draining: false }
})
