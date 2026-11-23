import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROMPTS } from '../factory/agents/prompts'
import type { AgentName } from '../factory/agents/prompts'

// The editable config and which agents have a .factory/agents/<name>.md override.
export default defineEventHandler(async () => {
  const f = await (useFixtures() ?? useFactory())
  const prompts = (Object.keys(PROMPTS) as AgentName[]).map(name => ({
    name,
    overridden: existsSync(join(f.paths.factory, 'agents', `${name}.md`))
  }))
  return { config: f.config, prompts }
})
