import type { BaseChecksResult, DoctorCheck } from '~~/server/factory/setup'

const checks = ref<DoctorCheck[]>([])
const baseResult = ref<BaseChecksResult | null>(null)
const baseRunning = ref(false)
const checksScript = ref<string | null>(null)
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)

/** Doctor's results, shared by the header badge and the Setup page. */
export function useSetup() {
  const { act, refresh, connect } = useBoard()

  async function recheck() {
    loading.value = true
    try {
      const res = await $fetch<{ checks: DoctorCheck[], checksScript: string | null }>('/api/setup')
      checks.value = res.checks
      checksScript.value = res.checksScript
      error.value = null
    } catch (err) {
      if (sessionRefused(err)) return
      const e = err as { data?: { statusMessage?: string, message?: string }, message?: string }
      error.value = e.data?.statusMessage ?? e.data?.message ?? e.message ?? String(err)
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Runs init; returns its lines, or null when the factory refused (shown as a toast). */
  async function initialize(): Promise<string[] | null> {
    const res = await act<{ done: string[], checks: DoctorCheck[] }>('/api/setup/init')
    if (!res) return null
    checks.value = res.checks
    // init may have just written checks.sh, which the result does not carry.
    if (checksScript.value === null) await recheck()
    connect()
    await refresh().catch(() => {})
    return res.done
  }

  /** Runs checks.sh on origin/<base>; a refusal is shown as a toast and keeps the last result. */
  async function runBaseChecks() {
    baseRunning.value = true
    try {
      const res = await act<BaseChecksResult>('/api/setup/base-checks')
      if (res) baseResult.value = res
    } finally {
      baseRunning.value = false
    }
  }

  return { checks, checksScript, loaded, loading, error, recheck, initialize, baseResult, baseRunning, runBaseChecks }
}
