import { resolve } from 'node:path'
import type { H3Event } from 'h3'
import { acquireLock, createFactory, FIXTURE_READ_ONLY, fixtureDir, fixtureMode, openFixtures } from '../factory/service'
import type { Factory, FixtureBoard } from '../factory/service'

let instance: Promise<Factory> | null = null
let fixtures: Promise<FixtureBoard> | null = null

/** The project the server runs on; usable before `.factory/` exists. */
export function projectDir(): string {
  if (fixtureMode()) return fixtureDir()
  return resolve(process.env.FACTORY_PROJECT || process.cwd())
}

/** The sample board under `FACTORY_FIXTURES=1`, or null; read routes answer from it. */
export function useFixtures(): Promise<FixtureBoard> | null {
  if (!fixtureMode()) return null
  fixtures ??= openFixtures(projectDir()).catch((err: unknown) => {
    fixtures = null
    throw err
  })
  return fixtures
}

/** The project's factory, created once per server process with its orchestrator lock. */
export function useFactory(): Promise<Factory> {
  // the fixture board never takes a lock or drives jobs, whatever route asks
  if (fixtureMode()) throw createError({ statusCode: 403, statusMessage: FIXTURE_READ_ONLY })
  instance ??= (async () => {
    const factory = await createFactory(projectDir())
    const release = await acquireLock(factory.paths)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        // abort agents and checks so none outlives the board; give up after 10s
        const stopped = Promise.race([factory.orchestrator.shutdown(), new Promise(r => setTimeout(r, 10_000))])
        void stopped.finally(() => release()).finally(() => process.exit(0))
      })
    }
    process.once('exit', () => {
      void release()
    })
    return factory
  })().catch((err: unknown) => {
    // Forget a failed start (e.g. no config yet) so the board works after Initialize.
    instance = null
    throw err
  })
  return instance
}

/** Body field `text`, required and non-empty. */
export async function readText(event: H3Event, field = 'text'): Promise<string> {
  const body = await readBody<Record<string, unknown>>(event)
  const value = body?.[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw createError({ statusCode: 400, statusMessage: `${field} is required` })
  }
  return value
}

/** Runs an engine call and turns its refusals into a 409 with the reason. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const e = err as Error
    if ('statusCode' in e) throw e
    throw createError({ statusCode: 409, statusMessage: e.message.split('\n')[0], data: { message: e.message } })
  }
}
