<script setup lang="ts">
import type { ChipState } from '~/utils/chips'

defineProps<{ label: string, state: ChipState }>()

const STYLE: Record<ChipState, string> = {
  pending: 'border-dashed border-accented text-dimmed',
  running: 'border-primary bg-primary/10 text-primary motion-safe:animate-ring-pulse',
  PASS: 'border-transparent bg-success/15 text-success',
  CHANGES: 'border-transparent bg-warning/15 text-warning',
  FAIL: 'border-transparent bg-error/15 text-error',
  invalid: 'border-error text-error'
}
const TITLE: Record<ChipState, string> = {
  pending: 'waiting',
  running: 'running now',
  PASS: 'PASS',
  CHANGES: 'CHANGES',
  FAIL: 'FAIL',
  invalid: 'unreadable verdict'
}
</script>

<template>
  <span
    class="rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none"
    :class="STYLE[state]"
    :title="`${label}: ${TITLE[state]}`"
  >{{ label }}</span>
</template>
