<script setup lang="ts">
import type { Job } from '~/composables/useBoard'
import type { JobFile } from '~~/server/factory/service'
import { WAITING } from '~~/server/factory/types'

interface Detail { job: Job, files: JobFile[] }

const props = defineProps<{ jobId: string }>()
const emit = defineEmits<{ close: [] }>()
const { state, act } = useBoard()

// Not awaited: opening the panel must never hold up the board.
const { data, error, refresh } = useFetch<Detail>(() => `/api/jobs/${props.jobId}`)
// The previous job's response stays in `data` until the new one arrives.
const detail = computed(() => data.value?.job.id === props.jobId ? data.value : null)
const failed = computed(() => !detail.value && !!error.value)

const job = computed(() => state.value?.jobs.find(j => j.id === props.jobId) ?? detail.value?.job)
// From the live state: the fetched detail is only refetched when the job moves.
const stalled = computed(() => state.value?.errors[props.jobId])
const running = computed(() => state.value?.running.includes(props.jobId) ?? false)
const paused = computed(() => !running.value && !!state.value?.paused.includes(props.jobId))
watch(() => [props.jobId, job.value && `${job.value.stage}/${job.value.round}/${job.value.gate}/${JSON.stringify(job.value.reviews)}`], ([id], [was]) => {
  // A new job is fetched by useFetch itself.
  if (id === was) void refresh()
})

// While paused no tick runs, so a PR merged by hand is looked for when its escalated job is opened.
watch(() => job.value?.stage === 'needs-human' && job.value.pr ? props.jobId : null, (id) => {
  if (id) void act('/api/merged')
}, { immediate: true })
</script>

<template>
  <div
    v-if="job"
    class="@container md:h-full"
  >
    <!-- A container query can't style its own container, so the grid sits one level in. -->
    <div class="space-y-4 md:flex md:h-full md:flex-col md:@4xl:grid md:@4xl:grid-cols-[11rem_minmax(0,1fr)_18rem] md:@4xl:grid-rows-[auto_auto_auto_minmax(12rem,1fr)] md:@4xl:gap-x-4">
      <JobHeader
        :job="job"
        :running="running"
        :stalled="stalled"
        @close="emit('close')"
      />

      <UAlert
        v-if="stalled"
        class="md:shrink-0 md:@4xl:col-span-3"
        color="error"
        variant="subtle"
        title="Stalled"
        :description="stalled"
      />
      <UAlert
        v-else-if="paused"
        class="md:shrink-0 md:@4xl:col-span-3"
        color="neutral"
        variant="subtle"
        title="Paused"
        description="This job was cancelled. Resume continues it from its stage."
      />

      <JobDecision
        v-if="WAITING.has(job.stage)"
        :job="job"
        @refresh="refresh()"
      />

      <JobFiles
        :job-id="jobId"
        :files="detail?.files ?? null"
        :failed="failed"
        @refresh="refresh()"
      />

      <JobActivity :job-id="jobId" />
    </div>
  </div>
</template>
