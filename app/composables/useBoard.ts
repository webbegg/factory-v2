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
    | { type: 'log', message: string }
    | { type: 'queued', issues: number[] }
    | { type: 'idle' | 'hello' | 'ping' }

const state = ref<FactoryState | null>(null)
const activity = ref<Record<string, ActivityLine[]>>({})
const feed = ref<FeedEntry[]>([])
let feedId = 0
const connected = ref(false)
let source: EventSource | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
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
    } else if (e.type === 'queued') {
      if (state.value) state.value.queued = e.issues
    } else if (e.type === 'idle') {
      refreshSoon()
    }
  }

  function connect() {
    // A stream refused before init stays closed; Initialize reopens it.
    if ((source && source.readyState !== EventSource.CLOSED) || import.meta.server) return
    source = new EventSource('/api/events')
    source.onopen = () => {
      connected.value = true
      void refresh()
      // no tick runs while paused, so PRs merged by hand are looked for once per page load
      if (!checkedMerged) {
        checkedMerged = true
        void act('/api/merged')
      }
    }
    source.onerror = () => {
      connected.value = false
    }
    source.onmessage = msg => handle(JSON.parse(msg.data) as ServerEvent)
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

  return { state, activity, feed, connected, refresh, connect, act }
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
