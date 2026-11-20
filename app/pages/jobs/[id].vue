<script setup lang="ts">
import type { Job } from '~/composables/useBoard'

interface JobFile { path: string, first: string, tone: 'good' | 'warn' | 'stop' | null }
interface Detail { job: Job, files: JobFile[], error: string | null, running: boolean }

const route = useRoute()
const id = computed(() => String(route.params.id))
const { state, activity, act } = useBoard()

const { data, refresh } = await useFetch<Detail>(() => `/api/jobs/${id.value}`)
const selected = ref<string | null>(null)
const file = ref<string | null>(null)

const job = computed(() => state.value?.jobs.find(j => j.id === id.value) ?? data.value?.job)
watch(() => job.value && `${job.value.stage}/${job.value.round}/${job.value.gate}/${JSON.stringify(job.value.reviews)}`, () => refresh())

watch([() => data.value?.files, selected], async ([files]) => {
  const path = selected.value ?? files?.[0]?.path
  if (!path) return (file.value = null)
  const res = await $fetch<{ text: string }>(`/api/jobs/${id.value}/file`, { query: { path } }).catch(() => null)
  file.value = res?.text ?? null
}, { immediate: true })

const groups = computed(() => {
  const out: Array<{ label: string, files: JobFile[] }> = []
  for (const f of data.value?.files ?? []) {
    const label = f.path.includes('/') ? f.path.split('/')[0]!.replace('round-', 'Round ') : 'Job'
    const g = out.at(-1)
    if (g?.label === label) g.files.push(f)
    else out.push({ label, files: [f] })
  }
  return out
})
const current = computed(() => selected.value ?? data.value?.files[0]?.path ?? null)
const toneColor = (t: JobFile['tone']) => t === 'good' ? 'bg-success' : t === 'warn' ? 'bg-warning' : t === 'stop' ? 'bg-error' : 'bg-accented'

const lines = computed(() => activity.value[id.value] ?? [])
const text = ref('')
async function send(action: 'feedback' | 'reject' | 'answer') {
  if (await act(`/api/jobs/${id.value}/${action}`, { text: text.value })) {
    text.value = ''
    await refresh()
  }
}
</script>

<template>
  <UContainer class="max-w-none py-6">
    <div
      v-if="job"
      class="space-y-4"
    >
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          to="/"
          icon="i-lucide-arrow-left"
          color="neutral"
          variant="ghost"
          aria-label="Board"
        />
        <div>
          <p class="font-mono text-xs text-muted">
            {{ job.id }} · {{ job.stage }}<span v-if="job.round"> · round {{ job.round }}/{{ job.roundLimit }}</span>
            · ${{ job.costUsd.toFixed(2) }} · {{ elapsed(job) }}
          </p>
          <h1 class="text-lg font-semibold text-highlighted">
            {{ job.title }}
          </h1>
        </div>
        <div class="ms-auto flex flex-wrap gap-2">
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
            v-if="data?.error"
            label="Retry"
            icon="i-lucide-rotate-ccw"
            @click="act(`/api/jobs/${job.id}/retry`)"
          />
          <UButton
            v-if="data?.running"
            label="Cancel"
            icon="i-lucide-square"
            color="error"
            variant="subtle"
            @click="act(`/api/jobs/${job.id}/cancel`)"
          />
        </div>
      </div>

      <UAlert
        v-if="data?.error"
        color="error"
        variant="subtle"
        title="Stalled"
        :description="data.error"
      />

      <UCard v-if="job.stage === 'needs-human' || job.stage === 'needs-info'">
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
          <UTextarea
            v-model="text"
            :rows="4"
            class="w-full"
            :placeholder="job.stage === 'needs-human' ? 'What should change?' : 'Your answer'"
          />
          <div class="flex gap-2">
            <UButton
              v-if="job.stage === 'needs-human'"
              label="Send feedback"
              :disabled="!text.trim()"
              @click="send('feedback')"
            />
            <UButton
              v-else
              label="Answer"
              :disabled="!text.trim()"
              @click="send('answer')"
            />
            <UButton
              label="Reject"
              color="error"
              variant="subtle"
              :disabled="!text.trim()"
              @click="send('reject')"
            />
          </div>
        </div>
      </UCard>

      <div class="grid gap-4 lg:grid-cols-[14rem_1fr_22rem]">
        <nav class="space-y-3">
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
              @click="selected = f.path"
            >
              <span
                class="size-2 shrink-0 rounded-full"
                :class="toneColor(f.tone)"
              />
              {{ f.path.split('/').pop() }}
            </button>
          </div>
          <p
            v-if="!groups.length"
            class="px-2 text-sm text-dimmed"
          >
            No files yet.
          </p>
        </nav>

        <UCard>
          <MarkdownDoc
            v-if="file"
            :text="file"
          />
          <p
            v-else
            class="text-sm text-dimmed"
          >
            Intake hasn't written anything yet.
          </p>
        </UCard>

        <UCard :ui="{ body: 'p-3 sm:p-3' }">
          <p class="mb-2 text-xs font-semibold text-dimmed uppercase">
            Live activity
          </p>
          <ol class="max-h-[70vh] space-y-1 overflow-auto font-mono text-xs">
            <li
              v-for="(l, i) in lines"
              :key="i"
              :class="l.kind === 'error' ? 'text-error' : l.kind === 'tool' ? 'text-muted' : 'text-default'"
            >
              <span class="text-dimmed">{{ l.at }} {{ l.agent }}</span> {{ l.text }}
            </li>
          </ol>
          <p
            v-if="!lines.length"
            class="text-xs text-dimmed"
          >
            Agent activity appears here while this board is open.
          </p>
        </UCard>
      </div>
    </div>
    <p
      v-else
      class="text-sm text-muted"
    >
      No job {{ id }}.
    </p>
  </UContainer>
</template>
