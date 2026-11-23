<script setup lang="ts">
const props = defineProps<{ jobId: string }>()
const { activity } = useBoard()

const lines = computed(() => activity.value[props.jobId] ?? [])
</script>

<template>
  <UCard
    class="md:shrink-0 md:@xl:flex md:@xl:min-h-32 md:@xl:shrink md:@xl:basis-1/3 md:@xl:flex-col md:@4xl:col-start-3 md:@4xl:row-start-4 md:@4xl:min-h-0 md:@4xl:min-w-0"
    :ui="{ body: 'p-3 sm:p-3 md:@xl:flex md:@xl:min-h-0 md:@xl:flex-1 md:@xl:flex-col' }"
  >
    <p class="mb-2 text-xs font-semibold text-dimmed uppercase">
      Live activity
    </p>
    <!-- Wrapped, not as="ol": the viewport div would sit between the list and its items. -->
    <UScrollArea
      tabindex="0"
      class="md:@xl:min-h-0"
    >
      <ol class="space-y-1 font-mono text-xs">
        <li
          v-for="(l, i) in lines"
          :key="i"
          :class="l.kind === 'error' ? 'text-error' : l.kind === 'tool' ? 'text-muted' : 'text-default'"
        >
          <span class="text-dimmed">{{ l.at }} {{ l.agent }}</span> {{ l.text }}
        </li>
      </ol>
      <!-- Inside the region so it frames something to focus while idle. -->
      <p
        v-if="!lines.length"
        class="text-xs text-dimmed"
      >
        Agent activity appears here while this board is open.
      </p>
    </UScrollArea>
  </UCard>
</template>
