import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FactoryPaths, Job, JobEvent } from './types'

const ARCHIVED = /\.rejected-\d+$/

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

  /** Live jobs only: a folder archived by `archiveJob` keeps its job.json but is history, not a job. */
  async list(): Promise<Job[]> {
    const jobs: Job[] = []
    for (const id of await this.entries()) {
      if (!ARCHIVED.test(id) && existsSync(this.path(id, 'job.json'))) jobs.push(await this.load(id))
    }
    return jobs
  }

  /** Every name in the jobs folder, archives included, sorted. */
  async entries(): Promise<string[]> {
    if (!existsSync(this.paths.jobs)) return []
    return (await readdir(this.paths.jobs)).sort()
  }

  /** Renames a job's folder to `<id>.rejected-<n>`, the next free n, so the issue can get a fresh job. */
  async archiveJob(id: string): Promise<string> {
    const prefix = `${id}.rejected-`
    const taken = (await this.entries())
      .filter(name => name.startsWith(prefix))
      .map(name => name.slice(prefix.length))
      .filter(n => /^\d+$/.test(n))
      .map(Number)
    const to = `${prefix}${Math.max(0, ...taken) + 1}`
    await rename(this.dir(id), join(this.paths.jobs, to))
    return to
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

  /** Appends one line to the job's events.jsonl. The log is a record, not state: a failed append never fails the job. */
  async appendEvent(id: string, event: JobEvent): Promise<void> {
    try {
      await appendFile(this.path(id, 'events.jsonl'), `${JSON.stringify(event)}\n`)
    } catch {
      // nothing depends on the log
    }
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
