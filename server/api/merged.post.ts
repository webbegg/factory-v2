// The paused check: needs-human jobs whose PR was merged by hand move to merged.
export default defineEventHandler(async () => {
  const f = await useFactory()
  await f.orchestrator.checkMerged()
  return { ok: true }
})
