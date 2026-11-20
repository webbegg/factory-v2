<script setup lang="ts">
import type { Job } from '~/composables/useBoard'

const props = defineProps<{ job: Job, error?: string, running?: boolean, selected?: boolean }>()

const num = computed(() => props.job.id.split('-')[0])
const flag = computed(() => {
  if (props.error) return { label: 'stalled', color: 'error' as const }
  if (props.job.stage === 'needs-human') return { label: 'your call', color: 'warning' as const }
  if (props.job.stage === 'needs-info') return { label: 'asked author', color: 'info' as const }
  if (props.job.stage === 'rejected') return { label: 'rejected', color: 'neutral' as const }
  return null
})
const chips = computed(() => roundChips(props.job))
</script>

<template>
  <NuxtLink
    :to="{ path: '/', query: { job: job.id } }"
    class="block"
  >
    <UCard
      :ui="{ body: 'p-3 sm:p-3 space-y-2' }"
      :class="[selected ? 'ring-2 ring-primary' : job.stage === 'needs-human' ? 'ring-2 ring-warning' : '', job.stage === 'merged' || job.stage === 'rejected' ? 'opacity-70' : '']"
    >
      <div class="flex items-center gap-2 text-xs text-muted">
        <span
          v-if="running"
          class="size-2 animate-pulse rounded-full bg-primary"
          aria-label="running"
        />
        <span class="font-mono">{{ num }}</span>
        <span>#{{ job.issue }}</span>
        <span v-if="job.pr">· PR #{{ job.pr }}</span>
        <UBadge
          v-if="flag"
          :label="flag.label"
          :color="flag.color"
          variant="subtle"
          size="sm"
          class="ms-auto"
        />
      </div>
      <p class="text-sm font-medium text-highlighted line-clamp-2">
        {{ job.title }}
      </p>
      <div
        v-if="chips.length"
        class="flex flex-wrap items-center gap-1"
      >
        <span class="text-xs text-dimmed">R{{ job.round }}</span>
        <RoundChip
          v-for="c in chips"
          :key="c.key"
          :label="c.label"
          :state="c.state"
        />
      </div>
      <div class="flex items-center gap-2 text-xs text-muted">
        <UBadge
          v-if="job.intake?.risk"
          :label="job.intake.risk"
          :color="riskColor(job.intake.risk)"
          variant="outline"
          size="sm"
        />
        <span>${{ job.costUsd.toFixed(2) }}</span>
        <span>{{ elapsed(job) }}</span>
      </div>
    </UCard>
  </NuxtLink>
</template>
