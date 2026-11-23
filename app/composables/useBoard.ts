import type { FactoryConfig, Job, Stage } from '~~/server/factory/types'
import type { FeedEntry, FeedKind } from '~/utils/feed'

export type { Job, Stage }

export interface FactoryState {
  project: string
  config: FactoryConfig
  draining: boolean
  running: string[]
  queued: number[]
  errors: Record<string, string>
  paused: string[]
  jobs: Job[]
}

export interface ActivityLine {
  at: string
  agent: string
  kind: string
  text: string
}

type ServerEvent
  = | { type: 'job', job: Job }
    | { type: 'agent', jobId: string, agent: string, event: { kind: Exclude<FeedKind, 'status'>, text: string } }
    | { type: 'error', jobId: string, message: string }
    | { type: 'paused', jobId: string }
    | { type: 'archived', jobId: string, archived: string }
    | { type: 'log', message: string }
    | { type: 'queued', issues: number[] }
    | { type: 'idle' | 'hello' | 'ping' }

const state = ref<FactoryState | null>(null)
const activity = ref<Record<string, ActivityLine[]>>({})
const feed = ref<FeedEntry[]>([])
/** half-typed feedback or answer per job, kept while the panel is closed but not across a reload */
const drafts = ref<Record<string, string>>({})
let feedId = 0
const connected = ref(false)
let source: EventSource | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempt = 0
// true from an error until the next open, so the first connection never shows the banner
const reconnecting = ref(false)
let checkedMerged = false

const MAX_LINES = 300

function push<T>(list: T[], item: T) {
  list.push(item)
  if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES)
}

function addToFeed(at: string, sender: string, jobId: string | null, kind: FeedKind, text: string) {
  push(feed.value, { id: ++feedId, at, sender, jobId, kind, text })
}

/** Shared board state, kept live by the server's event stream. */
export function useBoard() {
  const toast = useToast()

  async function refresh() {
    state.value = await $fetch<FactoryState>('/api/state')
  }

  function refreshSoon() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, 300)
  }

  function handle(e: ServerEvent) {
    if (e.type === 'job') {
      const jobs = state.value?.jobs
      const i = jobs?.findIndex(j => j.id === e.job.id) ?? -1
      if (jobs && i >= 0) jobs[i] = e.job
      refreshSoon()
    } else if (e.type === 'agent') {
      const at = new Date().toLocaleTimeString()
      const lines = activity.value[e.jobId] ??= []
      push(lines, { at, agent: e.agent, kind: e.event.kind, text: e.event.text })
      addToFeed(at, e.agent, e.jobId, e.event.kind, e.event.text)
    } else if (e.type === 'log') {
      const { jobId, text } = parseStatus(e.message, state.value?.jobs.map(j => j.id) ?? [])
      addToFeed(new Date().toLocaleTimeString(), 'factory', jobId, 'status', text)
    } else if (e.type === 'error') {
      addToFeed(new Date().toLocaleTimeString(), 'factory', e.jobId, 'error', e.message)
      toast.add({ title: `${e.jobId} stalled`, description: e.message, color: 'error' })
      refreshSoon()
    } else if (e.type === 'paused') {
      // the operator cancelled it, so a status line is enough
      addToFeed(new Date().toLocaleTimeString(), 'factory', e.jobId, 'status', `${e.jobId} paused`)
      refreshSoon()
    } else if (e.type === 'archived') {
      addToFeed(new Date().toLocaleTimeString(), 'factory', e.jobId, 'status', `${e.jobId} archived as ${e.archived}`)
      refreshSoon()
    } else if (e.type === 'queued') {
      if (state.value) state.value.queued = e.issues
    } else if (e.type === 'idle') {
      refreshSoon()
    }
  }

  function connect() {
    // A closed stream is reopened by the reconnect timer, or sooner by Initialize.
    if ((source && source.readyState !== EventSource.CLOSED) || import.meta.server) return
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const stream = new EventSource('/api/events')
    source = stream
    stream.onopen = () => {
      if (source !== stream) return
      attempt = 0
      connected.value = true
      reconnecting.value = false
      void refresh()
      // no tick runs while paused, so PRs merged by hand are looked for once per page load
      if (!checkedMerged) {
        checkedMerged = true
        void act('/api/merged')
      }
    }
    stream.onerror = () => {
      if (source !== stream) return
      connected.value = false
      reconnecting.value = true
      // while CONNECTING the browser retries by itself; only a closed stream needs a new one
      if (stream.readyState !== EventSource.CLOSED || reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, reconnectDelay(attempt++))
    }
    stream.onmessage = (msg) => {
      if (source !== stream) return
      let e: ServerEvent
      try {
        e = JSON.parse(msg.data) as ServerEvent
      } catch {
        console.warn('Skipped an event stream frame that is not JSON:', msg.data)
        return
      }
      handle(e)
    }
  }

  /** POSTs an action; shows the factory's refusal as a toast and returns null. */
  async function act<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
    try {
      const res = await $fetch<T>(path as '/api/run', { method: 'POST', body }) as T
      refreshSoon()
      return res
    } catch (err) {
      const e = err as { data?: { statusMessage?: string, message?: string } }
      toast.add({ title: 'The factory refused', description: e.data?.statusMessage ?? e.data?.message ?? String(err), color: 'error' })
      return null
    }
  }

  return { state, activity, feed, drafts, connected, reconnecting, refresh, connect, act }
}

export function elapsed(job: Job): string {
  const end = job.ended ? Date.parse(job.ended) : Date.now()
  const min = Math.max(0, Math.floor((end - Date.parse(job.started)) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

export function verdictColor(v: string | null | undefined) {
  if (v === 'PASS') return 'success' as const
  if (v === 'CHANGES') return 'warning' as const
  if (v === 'FAIL' || v === 'invalid') return 'error' as const
  return 'neutral' as const
}

export function riskColor(risk: string | null | undefined) {
  return risk === 'high' ? 'error' as const : risk === 'medium' ? 'warning' as const : 'neutral' as const
}
