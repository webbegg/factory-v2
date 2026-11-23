import { fixtureState } from '../factory/service'

// Everything the board needs in one call.
export default defineEventHandler(async () => {
  const fixtures = useFixtures()
  if (fixtures) return fixtureState(await fixtures)
  const f = await useFactory()
  return {
    project: f.paths.repo,
    config: f.config,
    draining: f.orchestrator.isDraining,
    running: f.orchestrator.runningJobs(),
    queued: f.orchestrator.queuedIssues(),
    errors: Object.fromEntries(f.orchestrator.errors),
    paused: [...f.orchestrator.paused],
    jobs: await f.store.list()
  }
})
