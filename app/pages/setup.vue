<script setup lang="ts">
const { checks, checksScript, loaded, loading, error, recheck, initialize } = useSetup()

const STATE = {
  ok: { label: 'ok', color: 'success' },
  warn: { label: 'warn', color: 'warning' },
  fail: { label: 'failing', color: 'error' }
} as const

const initializing = ref(false)
const done = ref<string[] | null>(null)

async function runInit() {
  initializing.value = true
  try {
    done.value = await initialize()
  } finally {
    initializing.value = false
  }
}
</script>

<template>
  <UContainer class="max-w-3xl py-6 space-y-4">
    <div class="flex items-center gap-2">
      <h1 class="text-lg font-semibold text-highlighted">
        Setup
      </h1>
      <div class="ms-auto flex gap-2">
        <UButton
          v-if="canInitialize(checks)"
          icon="i-lucide-hammer"
          label="Initialize"
          :loading="initializing"
          :disabled="loading"
          @click="runInit"
        />
        <UButton
          icon="i-lucide-refresh-cw"
          label="Re-check"
          color="neutral"
          variant="subtle"
          :loading="loading"
          :disabled="initializing"
          @click="recheck"
        />
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Doctor failed"
      :description="error"
    />

    <UCard v-if="done">
      <template #header>
        <span class="text-sm font-medium text-highlighted">Initialize</span>
      </template>
      <ul class="space-y-1 text-sm font-mono">
        <li
          v-for="(line, i) in done"
          :key="i"
        >
          {{ line }}
        </li>
      </ul>
      <p
        v-if="!done.length"
        class="text-sm text-muted"
      >
        Nothing to do.
      </p>
    </UCard>

    <UCard>
      <template #header>
        <span class="text-sm font-medium text-highlighted">Checks</span>
      </template>
      <div
        v-if="!loaded && loading"
        class="flex items-center gap-2 text-sm text-muted"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="animate-spin"
        />
        Running doctor…
      </div>
      <ul
        v-else
        class="divide-y divide-default"
      >
        <li
          v-for="c in checks"
          :key="c.name"
          class="flex items-start gap-3 py-2"
        >
          <UBadge
            :label="STATE[checkState(c)].label"
            :color="STATE[checkState(c)].color"
            variant="subtle"
            class="w-16 shrink-0 justify-center"
          />
          <div class="min-w-0">
            <p class="text-sm text-highlighted">
              {{ c.name }}
            </p>
            <p class="text-sm text-muted break-words">
              {{ c.detail }}
            </p>
          </div>
        </li>
      </ul>
    </UCard>

    <UCard>
      <template #header>
        <span class="text-sm font-medium text-highlighted">.factory/checks.sh</span>
      </template>
      <template v-if="checksScript !== null">
        <p class="mb-2 text-sm text-muted">
          The gate runs this script in every worktree. Review it and commit it.
        </p>
        <pre class="overflow-x-auto rounded-md bg-elevated p-3 text-xs">{{ checksScript }}</pre>
      </template>
      <p
        v-else-if="loaded"
        class="text-sm text-muted"
      >
        .factory/checks.sh does not exist yet. Initialize creates it.
      </p>
      <div
        v-else
        class="flex items-center gap-2 text-sm text-muted"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="animate-spin"
        />
        Running doctor…
      </div>
    </UCard>
  </UContainer>
</template>
