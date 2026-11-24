<script setup lang="ts">
import type { Job } from '~/composables/useBoard'
import type { PendingImage } from '~~/server/factory/attachments'

// prHead: the PR head GitHub reported when the detail loaded, which Merge pins to
const props = defineProps<{ job: Job, prHead: string | null }>()
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
const shortHead = computed(() => props.prHead?.slice(0, 7) ?? null)

const sending = ref<'feedback' | 'reject' | 'answer' | 'merge' | 'already-merged' | null>(null)
const confirmingMerge = ref(false)
const confirmingReject = ref(false)
const askingMerge = ref(false)

function done(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete drafts.value[id]
  images.value = []
  emit('refresh')
}

async function reject() {
  confirmingReject.value = false
  await send('reject')
}

// Text that reads like an approval may have meant Merge; the question never blocks sending it.
function feedback() {
  if (props.job.pr && looksLikeApproval(text.value)) askingMerge.value = true
  else void send('feedback')
}
function mergeInstead() {
  askingMerge.value = false
  confirmingMerge.value = true
}
async function feedbackAnyway() {
  askingMerge.value = false
  await send('feedback')
}

async function merge() {
  confirmingMerge.value = false
  // One action per job at a time, whichever it is.
  if (sending.value || !props.prHead) return
  sending.value = 'merge'
  const id = props.job.id
  const reason = text.value.trim()
  const ok = await act(`/api/jobs/${id}/merge`, reason ? { commit: props.prHead, reason } : { commit: props.prHead })
  sending.value = null
  if (ok) done(id)
}

async function alreadyMerged() {
  if (sending.value) return
  sending.value = 'already-merged'
  const id = props.job.id
  const ok = await act(`/api/jobs/${id}/already-merged`)
  sending.value = null
  if (ok) done(id)
}

async function send(action: 'feedback' | 'reject' | 'answer') {
  // One action per job at a time: a second click would upload and send again.
  if (sending.value) return
  sending.value = action
  const id = props.job.id
  const body = await withImages(text.value, images.value)
  const ok = body !== null && await act(`/api/jobs/${id}/${action}`, { text: body })
  sending.value = null
  if (ok) done(id)
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
            here to approve it, say it was already merged on GitHub, tell the builder what to change, or reject it.
          </template>
          <template v-else>
            Tell the builder what to change, or reject it.
          </template>
        </template>
        <template v-else>
          Intake asked the author a question on the issue. Answer it here (posted as you) to send the job back to intake, or reject it.
        </template>
      </p>
      <p
        v-if="job.stage === 'needs-human' && job.pr"
        class="text-xs text-muted"
      >
        <template v-if="shortHead">
          PR head <code class="font-mono">{{ shortHead }}</code>
        </template>
        <template v-else>
          PR head unknown, so Merge is off.
        </template>
      </p>
      <ImageAttachments v-model="images">
        <UTextarea
          v-model="text"
          :rows="4"
          class="w-full"
          :placeholder="job.stage === 'needs-human' ? 'Feedback for the builder, or an optional reason for Merge, Already merged or Reject' : 'Your answer'"
        />
      </ImageAttachments>
      <div
        v-if="job.stage === 'needs-human'"
        class="flex flex-wrap gap-2"
      >
        <UButton
          label="Send feedback"
          :loading="sending === 'feedback'"
          :disabled="!text.trim() || !!sending"
          @click="feedback"
        />
        <UButton
          v-if="job.pr"
          label="Merge"
          color="success"
          variant="subtle"
          :loading="sending === 'merge'"
          :disabled="!prHead || !!sending"
          @click="confirmingMerge = true"
        />
        <UButton
          v-if="job.pr"
          label="Already merged"
          color="neutral"
          variant="subtle"
          :loading="sending === 'already-merged'"
          :disabled="!!sending"
          @click="alreadyMerged"
        />
        <UButton
          label="Reject"
          color="error"
          variant="subtle"
          :loading="sending === 'reject'"
          :disabled="!!sending"
          @click="confirmingReject = true"
        />
      </div>
      <div
        v-else
        class="flex gap-2"
      >
        <UButton
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
          @click="confirmingReject = true"
        />
      </div>
      <UModal
        v-model:open="confirmingReject"
        :title="`Reject ${job.id}?`"
        :description="text.trim() ? 'The job moves to rejected, with your note.' : 'The job moves to rejected.'"
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
        v-model:open="askingMerge"
        title="Did you mean Merge?"
        description="This feedback reads like an approval. Merge the PR with it as your reason, or send it to the builder as feedback."
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
              label="Send as feedback anyway"
              color="neutral"
              variant="subtle"
              @click="feedbackAnyway"
            />
            <UButton
              label="Merge"
              color="success"
              :disabled="!prHead"
              @click="mergeInstead"
            />
          </div>
        </template>
      </UModal>
      <UModal
        v-model:open="confirmingMerge"
        :title="`Merge PR #${job.pr} at ${shortHead}?`"
        :description="`The factory will merge ${shortHead} only: if the branch moves first, the job comes back to you. It syncs the branch with the base, runs the gate again, and merges through GitHub.`"
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
