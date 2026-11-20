<script setup lang="ts">
import type { WatchStopHandle } from 'vue'

const { state, log, act } = useBoard()
const route = useRoute()

const columns = computed(() => COLUMNS.map(c => ({
  ...c,
  // newest first
  jobs: (state.value?.jobs ?? []).filter(j => c.stages.includes(j.stage)).reverse()
})))
const running = computed(() => (state.value?.jobs ?? []).filter(j => LIVE_STAGES.has(j.stage)).length)
const total = computed(() => (state.value?.jobs ?? []).reduce((a, j) => a + j.costUsd, 0))
const issueToRun = ref<number | undefined>()

async function runOne() {
  if (!issueToRun.value) return
  const res = await act<{ job: { id: string } }>('/api/run', { issue: issueToRun.value })
  if (res) await navigateTo({ path: '/', query: { job: res.job.id } })
}

const selected = computed(() => selectedJobId(route.query.job, state.value?.jobs.map(j => j.id)))
// Stays true until the panel has slid out, so the strip doesn't widen under it.
const open = ref(false)
watch(selected, (id) => {
  if (id) open.value = true
}, { immediate: true })
const strip = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)

const close = () => navigateTo('/')

function follow(id: string) {
  void nextTick(() => {
    const card = strip.value?.querySelector(`[data-job="${CSS.escape(id)}"]`)
    const behavior = matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' : 'auto'
    card?.scrollIntoView({ inline: 'start', block: 'nearest', behavior })
  })
}

// Follows the selected job into its new column when a live update moves it.
let stopFollow: WatchStopHandle | null = null
function track(id: string | null) {
  stopFollow?.()
  stopFollow = null
  if (!id) return
  const column = () => {
    const job = state.value?.jobs.find(j => j.id === id)
    return job ? columnIndex(job.stage) : -1
  }
  stopFollow = watch(column, () => follow(id), { immediate: true })
}

const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
function inTextField(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // Nuxt UI overlays render in a portal; one still in the DOM gets this Esc.
  const overlayOpen = e.defaultPrevented || [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')]
    .some(el => !panel.value?.contains(el))
  const active = document.activeElement
  const action = escapeAction({ overlayOpen, inTextField: inTextField(active), hasSelection: !!selected.value })
  if (action === 'blur') (active as HTMLElement).blur()
  else if (action === 'close') void close()
}

let stopSelection: WatchStopHandle | null = null
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  stopSelection = watch(selected, track, { immediate: true })
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  stopSelection?.()
  stopFollow?.()
})
</script>

<template>
  <UContainer class="max-w-none py-6 space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-sm text-muted">
        {{ running }} running · {{ state?.config.concurrency ?? '–' }} at a time ·
        ${{ total.toFixed(2) }} API-equivalent estimate
      </p>
      <form
        class="ms-auto flex items-center gap-2"
        @submit.prevent="runOne"
      >
        <UInput
          v-model.number="issueToRun"
          type="number"
          placeholder="Issue #"
          class="w-28"
        />
        <UButton
          type="submit"
          label="Run issue"
          color="neutral"
          variant="subtle"
          :disabled="!issueToRun"
        />
      </form>
    </div>

    <div
      class="md:flex md:items-start md:gap-4"
      :class="open ? 'overflow-x-clip' : ''"
    >
      <div
        ref="strip"
        :class="open ? 'md:w-[16.5rem] md:shrink-0 md:scroll-px-3 md:overflow-x-auto md:p-1' : ''"
      >
        <div
          class="grid grid-cols-1 gap-3"
          :class="open ? 'md:flex' : 'md:grid-cols-4 xl:grid-cols-7'"
        >
          <section
            v-for="c in columns"
            :key="c.label"
            class="flex min-h-40 flex-col gap-2 rounded-lg bg-elevated/50 p-2"
            :class="[c.human ? 'ring-1 ring-warning/50' : '', open ? 'md:w-64 md:shrink-0' : '']"
          >
            <header class="flex items-baseline gap-2 px-1">
              <h2 class="text-sm font-semibold text-highlighted">
                {{ c.label }}
              </h2>
              <span class="text-xs text-dimmed">{{ c.who }}</span>
              <span class="ms-auto text-xs text-muted">{{ c.jobs.length || '' }}</span>
            </header>
            <JobCard
              v-for="job in c.jobs"
              :key="job.id"
              :data-job="job.id"
              :job="job"
              :error="state?.errors[job.id]"
              :running="state?.running.includes(job.id)"
              :selected="job.id === selected"
            />
            <p
              v-if="!c.jobs.length"
              class="px-1 text-xs text-dimmed"
            >
              —
            </p>
          </section>
        </div>
      </div>

      <Transition
        enter-active-class="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
        enter-from-class="motion-safe:translate-x-full"
        leave-active-class="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-in"
        leave-to-class="motion-safe:translate-x-full"
        @after-leave="open = false"
      >
        <aside
          v-if="selected"
          ref="panel"
          class="fixed inset-x-0 top-(--ui-header-height) bottom-0 z-30 overflow-y-auto bg-default p-4 md:static md:z-auto md:min-w-0 md:flex-1 md:overflow-visible md:bg-transparent md:p-1"
        >
          <JobDetail
            :job-id="selected"
            @close="close"
          />
        </aside>
      </Transition>
    </div>

    <UCard
      v-if="log.length"
      :ui="{ body: 'p-3 sm:p-3' }"
    >
      <pre class="max-h-48 overflow-auto text-xs text-muted">{{ log.slice(-40).join('\n') }}</pre>
    </UCard>
  </UContainer>
</template>
