<script setup lang="ts">
import type { PendingImage } from '~~/server/factory/attachments'

const { state, act } = useBoard()
const { withImages } = useAttachments()
const title = ref('')
const text = ref('')
const runNow = ref(true)
const images = ref<PendingImage[]>([])
const busy = ref(false)

async function submit() {
  busy.value = true
  const body = await withImages(text.value, images.value)
  const res = body === null ? null : await act<{ issue: number, job: { id: string } | null }>('/api/issues', { title: title.value, text: body, run: runNow.value })
  busy.value = false
  if (!res) return
  images.value = []
  useToast().add({ title: `Filed issue #${res.issue}`, color: 'success' })
  await navigateTo(res.job ? { path: '/', query: { job: res.job.id } } : '/')
}
</script>

<template>
  <UContainer class="max-w-2xl py-6">
    <UCard>
      <form
        class="space-y-4"
        @submit.prevent="submit"
      >
        <div>
          <h1 class="text-lg font-semibold text-highlighted">
            New request
          </h1>
          <p class="text-sm text-muted">
            Files a GitHub issue labeled <code>{{ state?.config.labels.queue ?? 'factory' }}</code>. Intake decides whether and how much of it gets built.
          </p>
        </div>
        <ImageAttachments v-model="images">
          <div class="space-y-4">
            <UFormField
              label="Title"
              required
            >
              <UInput
                v-model="title"
                placeholder="Add a dark mode toggle"
                class="w-full"
              />
            </UFormField>
            <UFormField
              label="What should it do?"
              required
            >
              <UTextarea
                v-model="text"
                :rows="8"
                class="w-full"
              />
            </UFormField>
          </div>
        </ImageAttachments>
        <UCheckbox
          v-model="runNow"
          label="Run it now"
        />
        <UButton
          type="submit"
          label="File request"
          :loading="busy"
          :disabled="!title.trim() || !text.trim()"
        />
      </form>
    </UCard>
  </UContainer>
</template>
