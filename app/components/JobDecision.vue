<script setup lang="ts">
import type { Job } from '~/composables/useBoard'
import type { PendingImage } from '~~/server/factory/attachments'

const props = defineProps<{ job: Job }>()
const emit = defineEmits<{ refresh: [] }>()
const { drafts, act } = useBoard()
const { withImages } = useAttachments()

const text = computed({
  get: () => drafts.value[props.job.id] ?? '',
  set: (v: string) => {
    drafts.value[props.job.id] = v
  }
})
const images = ref<PendingImage[]>([])
watch(() => props.job.id, () => {
  images.value = []
})

const sending = ref<'feedback' | 'reject' | 'answer' | 'merge' | null>(null)
const confirmingMerge = ref(false)
const confirmingReject = ref(false)
async function reject() {
  confirmingReject.value = false
  await send('reject')
}
async function merge() {
  if (sending.value) return
  confirmingMerge.value = false
  sending.value = 'merge'
  const ok = await act(`/api/jobs/${props.job.id}/merge`)
  sending.value = null
  if (ok) emit('refresh')
}

async function send(action: 'feedback' | 'reject' | 'answer') {
  // One action per job at a time: a second click would upload and send again.
  if (sending.value) return
  sending.value = action
  const id = props.job.id
  const body = await withImages(text.value, images.value)
  const ok = body !== null && await act(`/api/jobs/${id}/${action}`, { text: body })
  sending.value = null
  if (ok) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete drafts.value[id]
    images.value = []
    emit('refresh')
  }
}
</script>

<template>
  <UCard class="md:shrink-0 md:@4xl:col-span-3">
    <div class="space-y-3">
      <p class="text-sm text-highlighted">
        <template v-if="job.stage === 'needs-human'">
          This job needs your decision.
          <template v-if="job.pr">
            Merge
            <a
              v-if="job.prUrl"
              :href="job.prUrl"
              target="_blank"
              class="text-primary underline"
            >PR #{{ job.pr }}</a>
            here to approve it, tell the builder what to change, or reject it.
          </template>
          <template v-else>
            Tell the builder what to change, or reject it.
          </template>
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
          v-if="job.stage === 'needs-human' && job.pr"
          label="Merge"
          color="success"
          variant="subtle"
          :loading="sending === 'merge'"
          :disabled="!!sending"
          @click="confirmingMerge = true"
        />
        <UButton
          label="Reject"
          color="error"
          variant="subtle"
          :loading="sending === 'reject'"
          :disabled="!text.trim() || !!sending"
          @click="confirmingReject = true"
        />
      </div>
      <UModal
        v-model:open="confirmingReject"
        :title="`Reject ${job.id}?`"
        description="The job moves to rejected, with your note."
      >
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton
              label="Back"
              color="neutral"
              variant="ghost"
              @click="close"
            />
            <UButton
              label="Reject"
              color="error"
              @click="reject"
            />
          </div>
        </template>
      </UModal>
      <UModal
        v-model:open="confirmingMerge"
        :title="`Merge PR #${job.pr}?`"
        description="The factory will sync the branch with the base, run the gate again, and merge through GitHub."
      >
        <template #footer="{ close }">
          <div class="flex w-full justify-end gap-2">
            <UButton
              label="Cancel"
              color="neutral"
              variant="ghost"
              @click="close"
            />
            <UButton
              label="Merge"
              color="success"
              @click="merge"
            />
          </div>
        </template>
      </UModal>
    </div>
  </UCard>
</template>
