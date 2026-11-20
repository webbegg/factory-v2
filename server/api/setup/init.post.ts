import { doctor, init } from '../../factory/setup'

// Runs `factory init` on the served project; takes nothing from the request.
export default defineEventHandler(() => guarded(async () => {
  const done = await init(projectDir())
  return { done, checks: await doctor(projectDir()) }
}))
