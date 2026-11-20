import { saveConfig, validateConfigUpdate } from '../../factory/config'
import type { ConfigUpdate } from '../../factory/config'

// Save the Settings form to .factory/config.json and apply it to the running engine.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  let update: ConfigUpdate
  try {
    update = validateConfigUpdate(await readBody<unknown>(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message, cause: err })
  }
  const config = await saveConfig(f.paths, update)
  // Every engine component holds this one object and reads it per call, so
  // new values reach them without a restart; running jobs keep their roundLimit.
  Object.assign(f.config, config)
  return { config: f.config }
})
