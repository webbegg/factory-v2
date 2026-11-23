<script setup lang="ts">
import type { Job } from '~/composables/useBoard'

const props = defineProps<{ job: Job, running: boolean, stalled: string | undefined }>()
const emit = defineEmits<{ close: [] }>()
const { state, act } = useBoard()
const toast = useToast()

const action = computed(() => jobAction({ stage: props.job.stage, running: props.running, error: props.stalled }))

async function copyWorktree(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    toast.add({ title: 'Worktree path copied', description: path, color: 'success' })
  } catch (err) {
    toast.add({ title: 'Couldn\'t copy the worktree path', description: err instanceof Error ? err.message : String(err), color: 'error' })
  }
}

const sending = ref<'rerun' | null>(null)
const confirmingCancel = ref(false)
const confirmingRerun = ref(false)
async function rerun() {
  if (sending.value) return
  confirmingRerun.value = false
  sending.value = 'rerun'
  const id = props.job.id
  const res = await act<{ archived: string, labeled: boolean }>(`/api/jobs/${id}/rerun`)
  sending.value = null
  if (!res) return
  const label = state.value?.config.labels.queue ?? 'factory'
  toast.add(res.labeled
    ? { title: `${id} archived as ${res.archived}`, description: 'The issue gets a new job on the next drain, or now with Run issue.', color: 'success' }
    : { title: `${id} archived as ${res.archived}`, description: `The issue needs the ${label} label to run again.`, color: 'warning' })
  // the archived job is no longer on the board
  emit('close')
}
async function cancel() {
  confirmingCancel.value = false
  await act(`/api/jobs/${props.job.id}/cancel`)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3 md:shrink-0 md:@4xl:col-span-3">
    <div class="min-w-0">
      <p class="font-mono text-xs text-muted">
        {{ job.id }} · {{ job.stage }}<span v-if="job.round"> · round {{ job.round }}/{{ job.roundLimit }}</span>
        · ${{ job.costUsd.toFixed(2) }} · {{ elapsed(job) }}
      </p>
      <p
        v-if="job.branch"
        class="flex items-center gap-1 font-mono text-xs text-muted"
      >
        <span class="truncate">{{ job.branch }}</span>
        <UButton
          v-if="job.worktree"
          icon="i-lucide-copy"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Copy worktree path"
          @click="copyWorktree(job.worktree)"
        />
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
        v-if="action === 'retry'"
        label="Retry"
        icon="i-lucide-rotate-ccw"
        @click="act(`/api/jobs/${job.id}/retry`)"
      />
      <UButton
        v-else-if="action === 'resume'"
        label="Resume"
        icon="i-lucide-play"
        @click="act(`/api/jobs/${job.id}/retry`)"
      />
      <UButton
        v-else-if="action === 'cancel'"
        label="Cancel"
        icon="i-lucide-square"
        color="error"
        variant="subtle"
        @click="confirmingCancel = true"
      />
      <UButton
        v-if="job.stage === 'rejected'"
        label="Run again"
        icon="i-lucide-redo-2"
        :loading="sending === 'rerun'"
        @click="confirmingRerun = true"
      />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        aria-label="Close"
        @click="emit('close')"
      />
    </div>

    <UModal
      v-model:open="confirmingCancel"
      :title="`Cancel ${job.id}?`"
      description="The running agent or gate stops, and the job stays paused at its stage until you resume it."
    >
      <template #footer="{ close }">
        <div class="flex w-full justify-end gap-2">
          <UButton
            label="Keep running"
            color="neutral"
            variant="ghost"
            @click="close"
          />
          <UButton
            label="Cancel job"
            color="error"
            @click="cancel"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="confirmingRerun"
      :title="`Run ${job.id} again?`"
      description="The job folder is kept as an archive, and the issue can get a fresh job on the next drain or with Run issue."
    >
      <template #footer="{ close }">
        <div class="flex w-full justify-end gap-2">
          <UButton
            label="Keep rejected"
            color="neutral"
            variant="ghost"
            @click="close"
          />
          <UButton
            label="Run again"
            @click="rerun"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
