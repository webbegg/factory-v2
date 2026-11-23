import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addendumBody, PROMPTS } from '../factory/agents/prompts'
import type { AgentName } from '../factory/agents/prompts'

// The editable config, and which agents have a .factory/agents/<name>.md
// override or a .factory/agents/<name>.append.md addendum with more than comments.
export default defineEventHandler(async () => {
  const f = await (useFixtures() ?? useFactory())
  const hasAddendum = (name: AgentName) => {
    try {
      return addendumBody(readFileSync(join(f.paths.factory, 'agents', `${name}.append.md`), 'utf8')) !== null
    } catch {
      return false
    }
  }
  const prompts = (Object.keys(PROMPTS) as AgentName[]).map(name => ({
    name,
    overridden: existsSync(join(f.paths.factory, 'agents', `${name}.md`)),
    addendum: hasAddendum(name)
  }))
  return { config: f.config, prompts }
})
