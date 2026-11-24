import { jobFiles } from '../../../factory/service'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const fixtures = useFixtures()
  if (fixtures) {
    const { store, fixtures: data } = await fixtures
    return guarded(async () => ({
      job: await store.load(id),
      files: await jobFiles(store, id),
      error: data.errors[id] ?? null,
      running: data.running.includes(id),
      prHead: data.prHeads[id] ?? null
    }))
  }
  const f = await useFactory()
  return guarded(async () => {
    const job = await f.store.load(id)
    // what the Merge button pins to; without it the panel only disables Merge
    const prHead = job.stage === 'needs-human' && job.pr ? await f.github.prHead(job.pr).catch(() => null) : null
    return {
      job,
      files: await jobFiles(f.store, id),
      error: f.orchestrator.errors.get(id) ?? null,
      running: f.orchestrator.runningJobs().includes(id),
      prHead
    }
  })
})
