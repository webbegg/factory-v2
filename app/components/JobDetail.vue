<script setup lang="ts">
import type { Job } from '~/composables/useBoard'
import type { PendingImage } from '~~/server/factory/attachments'

interface JobFile { path: string, first: string, tone: 'good' | 'warn' | 'stop' | null }
interface Detail { job: Job, files: JobFile[], error: string | null, running: boolean }

const props = defineProps<{ jobId: string }>()
const emit = defineEmits<{ close: [] }>()
const { state, activity, act } = useBoard()
const { withImages } = useAttachments()

// Not awaited: opening the panel must never hold up the board.
const { data, error, refresh } = useFetch<Detail>(() => `/api/jobs/${props.jobId}`)
// The previous job's response stays in `data` until the new one arrives.
const detail = computed(() => data.value?.job.id === props.jobId ? data.value : null)
const failed = computed(() => !detail.value && !!error.value)
const selected = ref<string | null>(null)
const file = ref<string | null>(null)
const loading = ref(false)
const text = ref('')
const images = ref<PendingImage[]>([])

const job = computed(() => state.value?.jobs.find(j => j.id === props.jobId) ?? detail.value?.job)
watch(() => [props.jobId, job.value && `${job.value.stage}/${job.value.round}/${job.value.gate}/${JSON.stringify(job.value.reviews)}`], ([id], [was]) => {
  // A new job is fetched by useFetch itself.
  if (id === was) void refresh()
})

watch(() => props.jobId, () => {
  selected.value = null
  text.value = ''
  images.value = []
})

const current = computed(() => selected.value ?? detail.value?.files[0]?.path ?? null)
let request = 0
watch([() => props.jobId, () => detail.value?.files, current], async () => {
  const id = props.jobId
  const path = current.value
  const mine = ++request
  if (!path) {
    file.value = null
    loading.value = false
    return
  }
  loading.value = true
  const res = await $fetch<{ text: string }>(`/api/jobs/${id}/file`, { query: { path } }).catch(() => null)
  // The user moved to another file or job while this one loaded.
  if (mine !== request) return
  file.value = res?.text ?? null
  loading.value = false
}, { immediate: true })

const groups = computed(() => {
  const out: Array<{ label: string, files: JobFile[] }> = []
  for (const f of detail.value?.files ?? []) {
    const label = f.path.includes('/') ? f.path.split('/')[0]!.replace('round-', 'Round ') : 'Job'
    const g = out.at(-1)
    if (g?.label === label) g.files.push(f)
    else out.push({ label, files: [f] })
  }
  return out
})
const toneColor = (t: JobFile['tone']) => t === 'good' ? 'bg-success' : t === 'warn' ? 'bg-warning' : t === 'stop' ? 'bg-error' : 'bg-accented'
const empty = computed(() => {
  if (!current.value) return ''
  const writer = fileWriter(current.value)
  return `${writer[0]!.toUpperCase()}${writer.slice(1)} hasn't written ${current.value.split('/').pop()} yet.`
})

const lines = computed(() => activity.value[props.jobId] ?? [])
const sending = ref<'feedback' | 'reject' | 'answer' | null>(null)
async function send(action: 'feedback' | 'reject' | 'answer') {
  // One action per job at a time: a second click would upload and send again.
  if (sending.value) return
  sending.value = action
  const body = await withImages(text.value, images.value)
  const ok = body !== null && await act(`/api/jobs/${props.jobId}/${action}`, { text: body })
  sending.value = null
  if (ok) {
    text.value = ''
    images.value = []
    await refresh()
  }
}
</script>

<template>
  <div
    v-if="job"
    class="@container md:h-full"
  >
    <!-- A container query can't style its own container, so the grid sits one level in. -->
    <div class="space-y-4 md:flex md:h-full md:flex-col md:@4xl:grid md:@4xl:grid-cols-[11rem_minmax(0,1fr)_18rem] md:@4xl:grid-rows-[auto_auto_auto_minmax(12rem,1fr)] md:@4xl:gap-x-4">
      <div class="flex flex-wrap items-center gap-3 md:shrink-0 md:@4xl:col-span-3">
        <div class="min-w-0">
          <p class="font-mono text-xs text-muted">
            {{ job.id }} · {{ job.stage }}<span v-if="job.round"> · round {{ job.round }}/{{ job.roundLimit }}</span>
            · ${{ job.costUsd.toFixed(2) }} · {{ elapsed(job) }}
          </p>
          <h2 class="text-lg font-semibold break-words text-highlighted">
            {{ job.title }}
          </h2>
        </div>
        <div class="ms-auto flex flex-wrap items-center gap-2">
          <UButton
            v-if="job.issueUrl"
            :to="job.issueUrl"
            target="_blank"
            :label="`Issue #${job.issue}`"
            icon="i-simple-icons-github"
            color="neutral"
            variant="subtle"
          />
          <UButton
            v-if="job.prUrl"
            :to="job.prUrl"
            target="_blank"
            :label="`PR #${job.pr}`"
            icon="i-lucide-git-pull-request"
            color="neutral"
            variant="subtle"
          />
          <UButton
            v-if="detail?.error"
            label="Retry"
            icon="i-lucide-rotate-ccw"
            @click="act(`/api/jobs/${job.id}/retry`)"
          />
          <UButton
            v-if="detail?.running"
            label="Cancel"
            icon="i-lucide-square"
            color="error"
            variant="subtle"
            @click="act(`/api/jobs/${job.id}/cancel`)"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            aria-label="Close"
            @click="emit('close')"
          />
        </div>
      </div>

      <UAlert
        v-if="detail?.error"
        class="md:shrink-0 md:@4xl:col-span-3"
        color="error"
        variant="subtle"
        title="Stalled"
        :description="detail.error"
      />

      <UCard
        v-if="job.stage === 'needs-human' || job.stage === 'needs-info'"
        class="md:shrink-0 md:@4xl:col-span-3"
      >
        <div class="space-y-3">
          <p class="text-sm text-highlighted">
            <template v-if="job.stage === 'needs-human'">
              This job needs your decision. Merge
              <a
                v-if="job.prUrl"
                :href="job.prUrl"
                target="_blank"
                class="text-primary underline"
              >PR #{{ job.pr }}</a>
              on GitHub to approve it, tell the builder what to change, or reject it.
            </template>
            <template v-else>
              Intake asked the author a question on the issue. Answer it here (posted as you) to send the job back to intake, or reject it.
            </template>
          </p>
          <ImageAttachments v-model="images">
            <UTextarea
              v-model="text"
              :rows="4"
              class="w-full"
              :placeholder="job.stage === 'needs-human' ? 'What should change?' : 'Your answer'"
            />
          </ImageAttachments>
          <div class="flex gap-2">
            <UButton
              v-if="job.stage === 'needs-human'"
              label="Send feedback"
              :loading="sending === 'feedback'"
              :disabled="!text.trim() || !!sending"
              @click="send('feedback')"
            />
            <UButton
              v-else
              label="Answer"
              :loading="sending === 'answer'"
              :disabled="!text.trim() || !!sending"
              @click="send('answer')"
            />
            <UButton
              label="Reject"
              color="error"
              variant="subtle"
              :loading="sending === 'reject'"
              :disabled="!text.trim() || !!sending"
              @click="send('reject')"
            />
          </div>
        </div>
      </UCard>

      <div class="grid gap-4 @xl:grid-cols-[11rem_minmax(0,1fr)] md:shrink-0 md:@xl:min-h-48 md:@xl:flex-1 md:@xl:shrink md:@xl:grid-rows-[minmax(0,1fr)] md:@4xl:contents">
        <UScrollArea
          as="nav"
          class="max-md:overflow-visible @max-xl:overflow-visible md:@4xl:col-start-1 md:@4xl:row-start-4"
          :ui="{ viewport: 'gap-3' }"
        >
          <div
            v-for="g in groups"
            :key="g.label"
            class="space-y-1"
          >
            <p class="px-2 text-xs font-semibold text-dimmed uppercase">
              {{ g.label }}
            </p>
            <button
              v-for="f in g.files"
              :key="f.path"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-elevated"
              :class="current === f.path ? 'bg-elevated text-highlighted' : 'text-muted'"
              :aria-current="current === f.path ? 'true' : undefined"
              @click="selected = f.path"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :class="toneColor(f.tone)"
              />
              <span class="truncate">{{ f.path.split('/').pop() }}</span>
            </button>
          </div>
          <p
            v-if="detail && !groups.length"
            class="px-2 text-sm text-dimmed"
          >
            No files yet.
          </p>
        </UScrollArea>

        <UCard
          v-if="!detail || current"
          class="min-w-0 md:@xl:flex md:@xl:flex-col md:@4xl:col-start-2 md:@4xl:row-start-4"
          :ui="{ body: 'p-0 sm:p-0 md:@xl:flex md:@xl:min-h-0 md:@xl:flex-1 md:@xl:flex-col' }"
        >
          <UScrollArea
            tabindex="0"
            class="p-4 sm:p-6 md:@xl:min-h-0 md:@xl:flex-1"
          >
            <div
              v-if="failed"
              class="flex flex-wrap items-center gap-3"
            >
              <p class="text-sm text-error">
                Couldn't load this job.
              </p>
              <UButton
                label="Try again"
                icon="i-lucide-rotate-ccw"
                color="neutral"
                variant="subtle"
                size="sm"
                @click="refresh()"
              />
            </div>
            <div
              v-else-if="loading || !detail"
              class="space-y-3"
              aria-label="Loading"
            >
              <USkeleton class="h-5 w-1/3" />
              <USkeleton class="h-4 w-full" />
              <USkeleton class="h-4 w-5/6" />
              <USkeleton class="h-4 w-2/3" />
            </div>
            <MarkdownDoc
              v-else-if="file"
              :text="file"
            />
            <p
              v-else
              class="text-sm text-dimmed"
            >
              {{ empty }}
            </p>
          </UScrollArea>
        </UCard>
      </div>

      <UCard
        class="md:shrink-0 md:@xl:flex md:@xl:min-h-32 md:@xl:shrink md:@xl:basis-1/3 md:@xl:flex-col md:@4xl:col-start-3 md:@4xl:row-start-4 md:@4xl:min-h-0 md:@4xl:min-w-0"
        :ui="{ body: 'p-3 sm:p-3 md:@xl:flex md:@xl:min-h-0 md:@xl:flex-1 md:@xl:flex-col' }"
      >
        <p class="mb-2 text-xs font-semibold text-dimmed uppercase">
          Live activity
        </p>
        <!-- Wrapped, not as="ol": the viewport div would sit between the list and its items. -->
        <UScrollArea
          tabindex="0"
          class="md:@xl:min-h-0"
        >
          <ol class="space-y-1 font-mono text-xs">
            <li
              v-for="(l, i) in lines"
              :key="i"
              :class="l.kind === 'error' ? 'text-error' : l.kind === 'tool' ? 'text-muted' : 'text-default'"
            >
              <span class="text-dimmed">{{ l.at }} {{ l.agent }}</span> {{ l.text }}
            </li>
          </ol>
          <!-- Inside the region so it frames something to focus while idle. -->
          <p
            v-if="!lines.length"
            class="text-xs text-dimmed"
          >
            Agent activity appears here while this board is open.
          </p>
        </UScrollArea>
      </UCard>
    </div>
  </div>
</template>
