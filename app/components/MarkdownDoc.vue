<script setup lang="ts">
const props = defineProps<{ text: string }>()

// renderMarkdown escapes all HTML first (see server/factory/render.test.ts),
// so v-html only ever receives the renderer's own tags.
const parts = computed(() => {
  const s = splitSummary(props.text)
  return {
    head: s.head,
    summary: s.summary === null ? null : renderMarkdown(s.summary),
    rest: renderMarkdown(s.rest)
  }
})
</script>

<template>
  <div class="space-y-4">
    <p
      v-if="parts.head"
      class="font-mono text-sm font-semibold text-highlighted whitespace-pre-line"
    >
      {{ parts.head }}
    </p>
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="parts.summary"
      class="md rounded-md bg-elevated p-3"
      v-html="parts.summary"
    />
    <div
      class="md"
      v-html="parts.rest"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>
