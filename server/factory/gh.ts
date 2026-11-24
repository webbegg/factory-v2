import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UploadImage } from './attachments'
import { exec, redact } from './exec'
import { MARKER } from './issue'
import type { CommitCheck, GitHubPort, IssueData, PrState, ThreadKind } from './ports'

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
  private repoId: string | null = null

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

  /** Factory text quotes git and gh output, which can hold a credential; it is redacted before posting. */
  async comment(kind: ThreadKind, number: number, body: string) {
    await this.gh([kind, 'comment', String(number), '--body', `${MARKER}\n${redact(body)}`])
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

  async prHead(number: number) {
    return (await this.json<{ headRefOid: string }>('pr', 'view', String(number), '--json', 'headRefOid')).headRefOid
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

  async prMerge(number: number, method: 'merge' | 'squash' | 'rebase', headSha: string) {
    await this.gh(['pr', 'merge', String(number), `--${method}`, '--match-head-commit', headSha])
  }

  /**
   * Check runs and commit statuses on `sha`, every page. `--jq` turns each page
   * into one line, so pages never run together into one unparseable blob.
   * Names and URLs are GitHub's text and are redacted like any other gh output.
   */
  async commitChecks(sha: string): Promise<CommitCheck[]> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha.slice(0, 60))}`)
    const pages = async <T>(endpoint: string, jq: string) =>
      (await this.gh(['api', `repos/{owner}/{repo}/commits/${sha}/${endpoint}?per_page=100`, '--paginate', '--jq', jq]))
        .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { total: number, items: T[] })
    const checks: CommitCheck[] = []
    const add = <T>(source: string, list: Array<{ total: number, items: T[] }>, map: (item: T) => CommitCheck) => {
      const items = list.flatMap(p => p.items)
      checks.push(...items.map(map))
      // a partial list must never read as "all passed"
      const total = Math.max(0, ...list.map(p => p.total))
      if (items.length < total) {
        checks.push({ name: `${source} list incomplete: GitHub returned ${items.length} of ${total}`, state: 'pending', url: null })
      }
    }
    const runs = await pages<{ name: string, status: string, conclusion: string | null, html_url: string | null }>(
      'check-runs', '{total: .total_count, items: [.check_runs[] | {name, status, conclusion, html_url}]}')
    add('check runs', runs, r => ({
      name: r.name,
      state: r.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '') ? 'success' : 'failure',
      url: r.html_url
    }))
    const statuses = await pages<{ context: string, state: string, target_url: string | null }>(
      'status', '{total: .total_count, items: [.statuses[] | {context, state, target_url}]}')
    add('commit statuses', statuses, s => ({
      name: s.context,
      state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
      url: s.target_url
    }))
    return checks.map(c => ({ ...c, name: redact(c.name), url: c.url === null ? null : redact(c.url) }))
  }

  openPrsForBranch(branch: string) {
    return this.json<Array<{ number: number, url: string }>>(
      'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url')
  }

  async prCreate(pr: { base: string, head: string, title: string, body: string }) {
    const out = await this.gh(['pr', 'create', '--draft', '--base', pr.base, '--head', pr.head, '--title', redact(pr.title), '--body', redact(pr.body)])
    const url = out.trim().split('\n').pop() ?? ''
    const number = Number(url.split('/').pop())
    if (!Number.isInteger(number) || number <= 0) throw new Error(`gh pr create gave no PR URL: ${redact(out.trim().slice(0, 200))}`)
    return { number, url }
  }

  /** Files a new request on the queue; returns the issue number. */
  async createIssue(title: string, body: string, label: string): Promise<number> {
    const url = (await this.gh(['issue', 'create', '--label', label, '--title', title, '--body', body])).trim()
    return Number(url.split('/').pop())
  }

  /**
   * Uploads through the endpoint `gh issue create --attach` uses, without posting
   * anything: the image belongs to the repo, so it is visible to whoever can see
   * the repo's issues. `gh api --input` needs a file (stdin gets no Content-Length);
   * the bytes go through a temp file that is always removed.
   */
  async uploadImages(images: UploadImage[]): Promise<string[]> {
    this.repoId ??= (await this.gh(['api', 'repos/{owner}/{repo}', '--jq', '.id'])).trim()
    const dir = await mkdtemp(join(tmpdir(), 'factory-upload-'))
    try {
      const urls: string[] = []
      for (const img of images) {
        const file = join(dir, img.name)
        await writeFile(file, img.bytes)
        const query = new URLSearchParams({ content_type: img.type, name: img.name, repository_id: this.repoId })
        urls.push((await this.gh(['api', '--method', 'POST', `https://uploads.github.com/user-attachments/assets?${query}`,
          '--header', 'Content-Type: application/octet-stream', '--input', file, '--jq', '.url'])).trim())
      }
      return urls
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
