<script setup lang="ts">
import type { Job } from '~/composables/useBoard'
import { section } from '~~/server/factory/markdown'

const props = defineProps<{ job: Job }>()
const human = computed(() => props.job.stage === 'needs-human')

// The question the job asks: the approver's (or factory's) decision, or intake's questions.
const { data } = useFetch<{ text: string }>(() => `/api/jobs/${props.job.id}/file`, {
  query: computed(() => ({ path: human.value ? 'decision.md' : 'intake.md' })),
  key: `inbox-${props.job.id}`
})
const question = computed(() => {
  const text = data.value?.text ?? ''
  return (human.value ? section(text, 'For the human') ?? section(text, 'Why') : section(text, 'Questions')) ?? ''
})
</script>

<template>
  <UCard>
    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <UBadge
          :label="human ? 'your call' : 'asked author'"
          :color="human ? 'warning' : 'info'"
          variant="subtle"
        />
        <span class="font-mono text-xs text-muted">{{ job.id }} · #{{ job.issue }}</span>
        <UButton
          :to="{ path: '/', query: { job: job.id } }"
          label="Open"
          trailing-icon="i-lucide-arrow-right"
          size="sm"
          class="ms-auto"
        />
      </div>
      <p class="font-medium text-highlighted">
        {{ job.title }}
      </p>
      <MarkdownDoc
        v-if="question"
        :text="question"
      />
    </div>
  </UCard>
</template>
