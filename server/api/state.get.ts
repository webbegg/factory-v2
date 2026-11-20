// Everything the board needs in one call.
export default defineEventHandler(async () => {
  const f = await useFactory()
  return {
    project: f.paths.repo,
    config: f.config,
    draining: f.orchestrator.isDraining,
    running: f.orchestrator.runningJobs(),
    errors: Object.fromEntries(f.orchestrator.errors),
    jobs: await f.store.list()
  }
})
