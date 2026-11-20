import { exec } from './exec'
import { MARKER } from './issue'
import type { GitHubPort, IssueData, PrState, ThreadKind } from './ports'

/** Runs `gh <args>` and returns stdout; throws on failure. */
export type GhRunner = (args: string[]) => Promise<string>

export function ghRunner(repo: string): GhRunner {
  return args => exec('gh', args, { cwd: repo })
}

interface RawIssue {
  number: number
  title: string
  body: string | null
  author: { login: string }
  labels: Array<{ name: string }>
  state: 'OPEN' | 'CLOSED'
  url: string
  comments: Array<{ author: { login: string } | null, body: string, createdAt: string }>
}

/** GitHubPort over the `gh` CLI, in the target project's checkout. */
export class GhCli implements GitHubPort {
  private login: string | null = null

  constructor(private gh: GhRunner) {}

  private async json<T>(...args: string[]): Promise<T> {
    return JSON.parse(await this.gh(args)) as T
  }

  async operator(): Promise<string> {
    this.login ??= (await this.gh(['api', 'user', '--jq', '.login'])).trim()
    return this.login
  }

  listIssues(label: string) {
    return this.json<Array<{ number: number, title: string }>>(
      'issue', 'list', '--label', label, '--state', 'open', '--limit', '200', '--json', 'number,title')
  }

  async fetchIssue(number: number): Promise<IssueData> {
    const raw = await this.json<RawIssue>('issue', 'view', String(number), '--json',
      'number,title,body,author,labels,state,url,comments')
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      author: raw.author.login,
      labels: raw.labels.map(l => l.name),
      state: raw.state,
      url: raw.url,
      comments: raw.comments.map(c => ({ author: c.author?.login ?? 'ghost', body: c.body, createdAt: c.createdAt }))
    }
  }

  async comment(kind: ThreadKind, number: number, body: string) {
    await this.gh([kind, 'comment', String(number), '--body', `${MARKER}\n${body}`])
  }

  /** A comment in the operator's own words (no marker), e.g. an answer to intake. */
  async reply(number: number, body: string) {
    await this.gh(['issue', 'comment', String(number), '--body', body])
  }

  async editLabels(kind: ThreadKind, number: number, change: { add?: string[], remove?: string[] }) {
    const args = [kind, 'edit', String(number)]
    if (change.add?.length) args.push('--add-label', change.add.join(','))
    if (change.remove?.length) args.push('--remove-label', change.remove.join(','))
    await this.gh(args)
  }

  async prState(number: number) {
    return (await this.json<{ state: PrState }>('pr', 'view', String(number), '--json', 'state')).state
  }

  async prIsDraft(number: number) {
    return (await this.json<{ isDraft: boolean }>('pr', 'view', String(number), '--json', 'isDraft')).isDraft
  }

  async prReady(number: number) {
    await this.gh(['pr', 'ready', String(number)])
  }

  async prClose(number: number) {
    await this.gh(['pr', 'close', String(number)])
  }

  async prMerge(number: number, method: 'merge' | 'squash' | 'rebase') {
    await this.gh(['pr', 'merge', String(number), `--${method}`])
  }

  openPrsForBranch(branch: string) {
    return this.json<Array<{ number: number, url: string }>>(
      'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url')
  }

  /** Files a new request on the queue; returns the issue number. */
  async createIssue(title: string, body: string, label: string): Promise<number> {
    const url = (await this.gh(['issue', 'create', '--label', label, '--title', title, '--body', body])).trim()
    return Number(url.split('/').pop())
  }
}
