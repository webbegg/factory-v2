// The board's Activity sidebar: one live feed of factory status lines and agent output.

export type FeedKind = 'status' | 'start' | 'text' | 'tool' | 'done' | 'error'

export interface FeedEntry {
  /** Increases by one per entry, so it stays a stable key after the cap trims old ones. */
  id: number
  at: string
  sender: string
  jobId: string | null
  kind: FeedKind
  text: string
}

export interface FeedGroup {
  key: number
  sender: string
  jobId: string | null
  at: string
  entries: FeedEntry[]
}

/** Runs of entries from the same sender and job, headed by the first entry's sender, job and time. */
export function groupFeed(entries: readonly FeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = []
  for (const e of entries) {
    const last = groups.at(-1)
    if (last && last.sender === e.sender && last.jobId === e.jobId) last.entries.push(e)
    else groups.push({ key: e.id, sender: e.sender, jobId: e.jobId, at: e.at, entries: [e] })
  }
  return groups
}

/** Pixels from the end that still count as the bottom; fractional scroll positions miss by a hair. */
export const BOTTOM_TOLERANCE_PX = 4

export function atBottom(el: { scrollTop: number, scrollHeight: number, clientHeight: number }, tolerance = BOTTOM_TOLERANCE_PX): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= tolerance
}

/** Splits `"<id>: text"` when id is a known job; `queue:` and gate lines stay whole with no job. */
export function parseStatus(message: string, jobIds: readonly string[]): { jobId: string | null, text: string } {
  const i = message.indexOf(': ')
  const id = i > 0 ? message.slice(0, i) : ''
  if (id && jobIds.includes(id)) return { jobId: id, text: message.slice(i + 2) }
  return { jobId: null, text: message }
}
