<script setup lang="ts">
const { state } = useBoard()

const waiting = computed(() => (state.value?.jobs ?? []).filter(j => j.stage === 'needs-human' || j.stage === 'needs-info'))
const stalled = computed(() => (state.value?.jobs ?? []).filter(j => state.value?.errors[j.id]))
</script>

<template>
  <UContainer class="max-w-3xl py-6 space-y-4">
    <h1 class="text-lg font-semibold text-highlighted">
      Waiting on you
    </h1>

    <InboxItem
      v-for="job in waiting"
      :key="job.id"
      :job="job"
    />

    <UCard
      v-for="job in stalled"
      :key="`stalled-${job.id}`"
    >
      <div class="flex items-center gap-2">
        <UBadge
          label="stalled"
          color="error"
          variant="subtle"
        />
        <span class="text-sm text-highlighted">{{ job.title }}</span>
        <UButton
          :to="{ path: '/', query: { job: job.id } }"
          label="Open"
          size="sm"
          class="ms-auto"
        />
      </div>
      <p class="mt-2 text-sm text-error">
        {{ state?.errors[job.id] }}
      </p>
    </UCard>

    <UEmpty
      v-if="!waiting.length && !stalled.length"
      icon="i-lucide-inbox"
      title="Nothing waits on you"
      description="Escalated PRs, intake questions and stalled jobs show up here."
    />
  </UContainer>
</template>
