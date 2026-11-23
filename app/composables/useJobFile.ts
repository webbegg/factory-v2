import type { MaybeRefOrGetter } from 'vue'

/**
 * The text of one job file, reloaded when the job, the path or `trigger` (the
 * detail's file list, so a refetched list reloads it) changes. Null when there
 * is no path or the file couldn't be read.
 */
export function useJobFile(id: MaybeRefOrGetter<string>, path: MaybeRefOrGetter<string | null>, trigger: MaybeRefOrGetter<unknown>) {
  const file = ref<string | null>(null)
  const loading = ref(false)
  let request = 0
  watch([() => toValue(id), () => toValue(trigger), () => toValue(path)], async ([job, , p]) => {
    const mine = ++request
    if (!p) {
      file.value = null
      loading.value = false
      return
    }
    loading.value = true
    const res = await $fetch<{ text: string }>(`/api/jobs/${job}/file`, { query: { path: p } }).catch(() => null)
    // The user moved to another file or job while this one loaded.
    if (mine !== request) return
    file.value = res?.text ?? null
    loading.value = false
  }, { immediate: true })
  return { file, loading }
}
