<script setup lang="ts">
const { state, log, act } = useBoard()

const columns = computed(() => COLUMNS.map(c => ({
  ...c,
  // newest first
  jobs: (state.value?.jobs ?? []).filter(j => c.stages.includes(j.stage)).reverse()
})))
const running = computed(() => (state.value?.jobs ?? []).filter(j => LIVE_STAGES.has(j.stage)).length)
const total = computed(() => (state.value?.jobs ?? []).reduce((a, j) => a + j.costUsd, 0))
const issueToRun = ref<number | undefined>()

async function runOne() {
  if (!issueToRun.value) return
  const res = await act<{ job: { id: string } }>('/api/run', { issue: issueToRun.value })
  if (res) await navigateTo(`/jobs/${res.job.id}`)
}
</script>

<template>
  <UContainer class="max-w-none py-6 space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <p class="text-sm text-muted">
        {{ running }} running · {{ state?.config.concurrency ?? '–' }} at a time ·
        ${{ total.toFixed(2) }} API-equivalent estimate
      </p>
      <form
        class="ms-auto flex items-center gap-2"
        @submit.prevent="runOne"
      >
        <UInput
          v-model.number="issueToRun"
          type="number"
          placeholder="Issue #"
          class="w-28"
        />
        <UButton
          type="submit"
          label="Run issue"
          color="neutral"
          variant="subtle"
          :disabled="!issueToRun"
        />
      </form>
    </div>

    <div class="grid grid-cols-1 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <section
        v-for="c in columns"
        :key="c.label"
        class="flex min-h-40 flex-col gap-2 rounded-lg bg-elevated/50 p-2"
        :class="c.human ? 'ring-1 ring-warning/50' : ''"
      >
        <header class="flex items-baseline gap-2 px-1">
          <h2 class="text-sm font-semibold text-highlighted">
            {{ c.label }}
          </h2>
          <span class="text-xs text-dimmed">{{ c.who }}</span>
          <span class="ms-auto text-xs text-muted">{{ c.jobs.length || '' }}</span>
        </header>
        <JobCard
          v-for="job in c.jobs"
          :key="job.id"
          :job="job"
          :error="state?.errors[job.id]"
          :running="state?.running.includes(job.id)"
        />
        <p
          v-if="!c.jobs.length"
          class="px-1 text-xs text-dimmed"
        >
          —
        </p>
      </section>
    </div>

    <UCard
      v-if="log.length"
      :ui="{ body: 'p-3 sm:p-3' }"
    >
      <pre class="max-h-48 overflow-auto text-xs text-muted">{{ log.slice(-40).join('\n') }}</pre>
    </UCard>
  </UContainer>
</template>
