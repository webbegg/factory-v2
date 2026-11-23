<script setup lang="ts">
import type { JobFile } from '~~/server/factory/service'

// `files` is null until the job's detail has loaded.
const props = defineProps<{ jobId: string, files: JobFile[] | null, failed: boolean }>()
const emit = defineEmits<{ refresh: [] }>()

const selected = ref<string | null>(null)
watch(() => props.jobId, () => {
  selected.value = null
})

const current = computed(() => selected.value ?? props.files?.[0]?.path ?? null)
const { file, loading } = useJobFile(() => props.jobId, current, () => props.files)

const groups = computed(() => {
  const out: Array<{ label: string, files: JobFile[] }> = []
  for (const f of props.files ?? []) {
    const label = f.path.includes('/') ? f.path.split('/')[0]!.replace('round-', 'Round ') : 'Job'
    const g = out.at(-1)
    if (g?.label === label) g.files.push(f)
    else out.push({ label, files: [f] })
  }
  return out
})
const empty = computed(() => {
  if (!current.value) return ''
  const writer = fileWriter(current.value)
  return `${writer[0]!.toUpperCase()}${writer.slice(1)} hasn't written ${current.value.split('/').pop()} yet.`
})
</script>

<template>
  <div class="grid gap-4 @xl:grid-cols-[11rem_minmax(0,1fr)] md:shrink-0 md:@xl:min-h-48 md:@xl:flex-1 md:@xl:shrink md:@xl:grid-rows-[minmax(0,1fr)] md:@4xl:contents">
    <UScrollArea
      as="nav"
      class="max-md:overflow-visible @max-xl:overflow-visible md:@4xl:col-start-1 md:@4xl:row-start-4"
      :ui="{ viewport: 'gap-3' }"
    >
      <div
        v-for="g in groups"
        :key="g.label"
        class="space-y-1"
      >
        <p class="px-2 text-xs font-semibold text-dimmed uppercase">
          {{ g.label }}
        </p>
        <button
          v-for="f in g.files"
          :key="f.path"
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-elevated"
          :class="current === f.path ? 'bg-elevated text-highlighted' : 'text-muted'"
          :aria-current="current === f.path ? 'true' : undefined"
          @click="selected = f.path"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="toneColor(f.tone)"
          />
          <span class="truncate">{{ f.path.split('/').pop() }}</span>
        </button>
      </div>
      <p
        v-if="files && !groups.length"
        class="px-2 text-sm text-dimmed"
      >
        No files yet.
      </p>
    </UScrollArea>

    <UCard
      v-if="!files || current"
      class="min-w-0 md:@xl:flex md:@xl:flex-col md:@4xl:col-start-2 md:@4xl:row-start-4"
      :ui="{ body: 'p-0 sm:p-0 md:@xl:flex md:@xl:min-h-0 md:@xl:flex-1 md:@xl:flex-col' }"
    >
      <UScrollArea
        tabindex="0"
        class="p-4 sm:p-6 md:@xl:min-h-0 md:@xl:flex-1"
      >
        <div
          v-if="failed"
          class="flex flex-wrap items-center gap-3"
        >
          <p class="text-sm text-error">
            Couldn't load this job.
          </p>
          <UButton
            label="Try again"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="subtle"
            size="sm"
            @click="emit('refresh')"
          />
        </div>
        <div
          v-else-if="loading || !files"
          class="space-y-3"
          aria-label="Loading"
        >
          <USkeleton class="h-5 w-1/3" />
          <USkeleton class="h-4 w-full" />
          <USkeleton class="h-4 w-5/6" />
          <USkeleton class="h-4 w-2/3" />
        </div>
        <!-- Logs are command output, not markdown: plain text, wrapped so this stays the only scroll region. -->
        <pre
          v-else-if="file && current?.endsWith('.log')"
          class="font-mono text-xs whitespace-pre-wrap wrap-anywhere text-default"
        >{{ file }}</pre>
        <MarkdownDoc
          v-else-if="file"
          :text="file"
        />
        <p
          v-else
          class="text-sm text-dimmed"
        >
          {{ empty }}
        </p>
      </UScrollArea>
    </UCard>
  </div>
</template>
