import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FactoryPaths, Job } from './types'

/**
 * Job state on disk: <repo>/.factory/jobs/<id>/job.json plus the agents' files.
 * Writes are atomic (temp file + rename). `update` serializes writers per job
 * inside this process; one orchestrator process per repo is enforced elsewhere.
 */
export class JobStore {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private paths: FactoryPaths) {}

  dir(id: string): string {
    return join(this.paths.jobs, id)
  }

  path(id: string, rel: string): string {
    return join(this.dir(id), rel)
  }

  async load(id: string): Promise<Job> {
    const text = await this.read(id, 'job.json')
    if (text === null) throw new Error(`no job ${id}`)
    return JSON.parse(text) as Job
  }

  async save(job: Job): Promise<void> {
    await this.write(job.id, 'job.json', JSON.stringify(job, null, 2) + '\n')
  }

  async list(): Promise<Job[]> {
    if (!existsSync(this.paths.jobs)) return []
    const ids = (await readdir(this.paths.jobs)).sort()
    const jobs: Job[] = []
    for (const id of ids) {
      if (existsSync(this.path(id, 'job.json'))) jobs.push(await this.load(id))
    }
    return jobs
  }

  async read(id: string, rel: string): Promise<string | null> {
    try {
      return await readFile(this.path(id, rel), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async write(id: string, rel: string, text: string | Uint8Array): Promise<void> {
    const target = this.path(id, rel)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, target)
  }

  async move(id: string, from: string, to: string): Promise<void> {
    await rename(this.path(id, from), this.path(id, to))
  }

  /** Moves a top-level `name.md` aside as `name-<k>.md`, the next free k, so a new one can't be mistaken for it. */
  async archive(id: string, rel: string): Promise<string | null> {
    if (!existsSync(this.path(id, rel))) return null
    const stem = rel.replace(/\.md$/, '')
    const k = (await this.files(id, new RegExp(`^${stem}-\\d+\\.md$`))).length + 1
    const to = `${stem}-${k}.md`
    await this.move(id, rel, to)
    return to
  }

  async files(id: string, pattern: RegExp): Promise<string[]> {
    if (!existsSync(this.dir(id))) return []
    return (await readdir(this.dir(id))).filter(f => pattern.test(f)).sort()
  }

  /** Load, transform, save, one caller at a time per job. Throwing saves nothing. */
  update(id: string, fn: (job: Job) => Job | Promise<Job>): Promise<Job> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const job = await fn(await this.load(id))
      await this.save(job)
      return job
    })
    this.queues.set(id, next)
    return next
  }
}
