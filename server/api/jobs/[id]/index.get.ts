import { jobFiles } from '../../../factory/service'

export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const id = getRouterParam(event, 'id')!
  return guarded(async () => ({
    job: await f.store.load(id),
    files: await jobFiles(f.store, id),
    error: f.orchestrator.errors.get(id) ?? null,
    running: f.orchestrator.runningJobs().includes(id)
  }))
})
