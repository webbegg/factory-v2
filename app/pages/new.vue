<script setup lang="ts">
const { state, act } = useBoard()
const title = ref('')
const text = ref('')
const runNow = ref(true)
const busy = ref(false)

async function submit() {
  busy.value = true
  const res = await act<{ issue: number, job: { id: string } | null }>('/api/issues', { title: title.value, text: text.value, run: runNow.value })
  busy.value = false
  if (!res) return
  useToast().add({ title: `Filed issue #${res.issue}`, color: 'success' })
  await navigateTo(res.job ? `/jobs/${res.job.id}` : '/')
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
