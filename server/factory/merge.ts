import type { Gate } from './gate'
import { Refused } from './machine'
import type { Machine } from './machine'
import type { Ports } from './ports'
import type { JobStore } from './store'
import type { FactoryConfig, Job } from './types'

export interface MergerOptions {
  config: FactoryConfig
  store: JobStore
  ports: Ports
  machine: Machine
  gate: Gate
}

/**
 * APPROVE → merged. Another job may have merged since this branch was gated,
 * so it syncs with the base, gates again, pushes, and merges through
 * `gh pr merge` (branch protection and required checks still apply). Any
 * failure hands the job to a human with the reason.
 */
export class Merger {
  constructor(private o: MergerOptions) {}

  async merge(id: string): Promise<Job> {
    const { store, ports, machine, gate, config } = this.o
    const base = config.baseBranch
    let job = await store.load(id)
    if (job.stage === 'approve') job = await machine.advance(id, 'merging')
    if (job.stage !== 'merging') throw new Refused(`${id} is in ${job.stage}, not approve or merging`)
    const pr = job.pr
    if (!pr) throw new Refused(`${id} has no PR`)
    if (await ports.github.prState(pr) === 'MERGED') return machine.advance(id, 'merged')

    const fail = async (why: string) => {
      await store.write(id, 'decision.md', `ESCALATE\n\n## Why\n${why}\n`)
      return machine.advance(id, 'needs-human')
    }

    await ports.git.fetch(job.worktree, base)
    const synced = await ports.git.merge(job.worktree, `origin/${base}`)
    if (!synced.ok) return fail(`The branch conflicts with ${base}:\n\n\`\`\`\n${synced.output}\n\`\`\``)

    const result = await gate.run(id, { merge: true })
    if (result.verdict !== 'PASS') {
      return fail(`The gate failed after syncing with ${base}. See round-${job.round}/merge-checks.md.\n\n${result.line}`)
    }

    try {
      await ports.git.push(job.worktree, job.branch)
      if (await ports.github.prIsDraft(pr)) await ports.github.prReady(pr)
      await ports.github.prMerge(pr, config.mergeMethod)
    } catch (err) {
      return fail(`The merge failed:\n\n\`\`\`\n${(err as Error).message}\n\`\`\``)
    }
    await ports.git.deleteRemoteBranch(job.branch)
    return machine.advance(id, 'merged')
  }
}
