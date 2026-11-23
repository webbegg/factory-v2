<script setup lang="ts">
import { waitingOnYou } from '~/utils/waiting'

const { state } = useBoard()

const errors = computed(() => state.value?.errors ?? {})
const waiting = computed(() => waitingOnYou(state.value?.jobs ?? [], errors.value))
const onAuthor = computed(() => (state.value?.jobs ?? []).filter(j => j.stage === 'needs-info' && !errors.value[j.id]))
</script>

<template>
  <UContainer class="max-w-3xl py-6 space-y-4">
    <h1 class="text-lg font-semibold text-highlighted">
      Waiting on you
    </h1>

    <template
      v-for="job in waiting"
      :key="job.id"
    >
      <UCard v-if="errors[job.id]">
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
          {{ errors[job.id] }}
        </p>
      </UCard>
      <InboxItem
        v-else
        :job="job"
      />
    </template>

    <template v-if="onAuthor.length">
      <h2 class="pt-2 text-lg font-semibold text-highlighted">
        Waiting on the author
      </h2>
      <InboxItem
        v-for="job in onAuthor"
        :key="job.id"
        :job="job"
      />
    </template>

    <UEmpty
      v-if="!waiting.length && !onAuthor.length"
      icon="i-lucide-inbox"
      title="Nothing waits on you"
      description="Escalated PRs and stalled jobs show up here, and jobs whose author was asked a question under their own heading."
    />
  </UContainer>
</template>
