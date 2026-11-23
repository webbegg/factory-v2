import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { factoryPaths } from '../../factory/config'
import { doctor } from '../../factory/setup'

// Doctor's checks and the gate script; uses projectDir() so it works before a config exists.
export default defineEventHandler(() => guarded(async () => {
  const repo = projectDir()
  const script = join(factoryPaths(repo).factory, 'checks.sh')
  const fixtures = useFixtures()
  return {
    // the fixture board runs no git, gh or claude, so its checks are canned
    checks: fixtures ? (await fixtures).fixtures.checks : await doctor(repo),
    checksScript: existsSync(script) ? await readFile(script, 'utf8') : null
  }
}))
