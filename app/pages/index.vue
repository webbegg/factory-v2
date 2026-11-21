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
  const issue = issueToRun.value
  const res = await act<{ job: { id: string } | null, queued: boolean }>('/api/run', { issue })
  if (!res) return
  if (res.job) return navigateTo({ path: '/', query: { job: res.job.id } })
  useToast().add({ title: `Issue #${issue} queued`, description: 'It starts when a slot frees up', color: 'info' })
  issueToRun.value = undefined
}

const selected = computed(() => selectedJobId(route.query.job, state.value?.jobs.map(j => j.id)))
// Stays true until the panel has slid out, so the strip doesn't widen under it.
const open = ref(false)
watch(selected, (id) => {
  if (id) open.value = true
}, { immediate: true })
// Both are UScrollArea instances; their elements are on $el.
const strip = ref<{ $el: HTMLElement } | null>(null)
const panel = ref<{ $el: HTMLElement } | null>(null)

const close = () => navigateTo('/')

function follow(id: string) {
  void nextTick(() => {
    const card = strip.value?.$el.querySelector(`[data-job="${CSS.escape(id)}"]`)
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
    .some(el => !panel.value?.$el.contains(el))
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
  <UContainer class="max-w-none py-6 space-y-4 md:flex md:h-full md:flex-col">
    <div class="flex flex-wrap items-center gap-3 md:shrink-0">
      <p class="text-sm text-muted">
        {{ running }} running · {{ state?.config.concurrency ?? '–' }} at a time ·
        ${{ total.toFixed(2) }} API-equivalent estimate
      </p>
      <p
        v-if="state?.queued.length"
        class="text-sm text-muted"
      >
        Queued: {{ state.queued.map(n => `#${n}`).join(', ') }} · waiting for a free slot
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
      class="md:flex md:min-h-0 md:flex-1 md:gap-4"
      :class="open ? 'overflow-x-clip' : ''"
    >
      <!-- The viewport is a size container, so columns cap at the board height (100cqh) while their rows fit content. -->
      <UScrollArea
        ref="strip"
        :orientation="open ? 'horizontal' : 'vertical'"
        class="max-md:overflow-visible"
        :class="open ? 'md:w-[16.5rem] md:shrink-0 md:scroll-px-3 md:p-1' : 'md:min-w-0 md:flex-1'"
        :ui="{ viewport: 'md:h-full md:@container-[size]' }"
      >
        <div
          class="grid grid-cols-1 gap-3 md:items-start"
          :class="open ? 'md:flex' : 'md:grid-cols-4 xl:grid-cols-7'"
        >
          <section
            v-for="c in columns"
            :key="c.label"
            class="flex min-h-[100px] flex-col gap-2 rounded-lg bg-elevated/50 p-2 md:max-h-[100cqh]"
            :class="[c.human ? 'ring-1 ring-warning/50' : '', open ? 'md:w-64 md:shrink-0' : '']"
          >
            <header class="flex items-baseline gap-2 px-1">
              <h2 class="text-sm font-semibold text-highlighted">
                {{ c.label }}
              </h2>
              <span class="text-xs text-dimmed">{{ c.who }}</span>
              <span class="ms-auto text-xs text-muted">{{ c.jobs.length || '' }}</span>
            </header>
            <!-- Where the gutter shows, the list widens into the column padding and keeps ring-2 room. -->
            <UScrollArea
              class="-m-1 p-1 max-md:overflow-visible md:min-h-0 md:flex-1 md:pointer-fine:-mx-2 md:pointer-fine:px-0.5"
              :ui="{ viewport: 'gap-2' }"
            >
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
            </UScrollArea>
          </section>
        </div>
      </UScrollArea>

      <Transition
        enter-active-class="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
        enter-from-class="motion-safe:translate-x-full"
        leave-active-class="motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-in"
        leave-to-class="motion-safe:translate-x-full"
        @after-leave="open = false"
      >
        <UScrollArea
          v-if="selected"
          ref="panel"
          as="aside"
          aria-label="Job details"
          class="fixed inset-x-0 top-(--ui-header-height) bottom-0 z-30 bg-default p-4 md:static md:z-auto md:min-w-0 md:flex-1 md:bg-transparent md:p-1"
          :ui="{ viewport: 'md:h-full' }"
        >
          <JobDetail
            :job-id="selected"
            @close="close"
          />
        </UScrollArea>
      </Transition>
    </div>

    <UCard
      v-if="log.length"
      class="md:shrink-0"
      :ui="{ body: 'p-3 sm:p-3' }"
    >
      <!-- overflow-x-scroll: the log scrolls both ways, and its bar keeps its space. -->
      <UScrollArea
        as="pre"
        tabindex="0"
        class="max-h-48 overflow-x-scroll text-xs text-muted"
      >
        {{ log.slice(-40).join('\n') }}
      </UScrollArea>
    </UCard>
  </UContainer>
</template>
