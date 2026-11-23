<script setup lang="ts">
import { newlyWaiting, pageTitle, waitingCount, waitingReasons } from '~/utils/waiting'
import type { WaitingReason } from '~/utils/waiting'

const { state, connected, reconnecting, connect, refresh, act } = useBoard()
const { checks, recheck } = useSetup()
const { active: notifying } = useNotifications()
onMounted(() => {
  connect()
  void refresh()
  void recheck()
})

const failing = computed(() => summarizeDoctor(checks.value).failures.length)

const waiting = computed(() => state.value ? waitingCount(state.value.jobs, state.value.errors) : 0)

useHead({
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  link: [{ rel: 'icon', href: '/favicon.ico' }],
  htmlAttrs: { lang: 'en' },
  title: computed(() => pageTitle(waiting.value))
})

// The first state is the baseline, so jobs already waiting at load never notify,
// and a refetch on reconnect only notifies what changed since the last state.
let seen: Record<string, WaitingReason> | null = null
watch(() => state.value && waitingReasons(state.value.jobs, state.value.errors), (next) => {
  if (!next) return
  if (seen && notifying.value) for (const { id, reason } of newlyWaiting(seen, next)) notify(id, reason)
  seen = next
}, { immediate: true })

function notify(id: string, reason: WaitingReason) {
  const job = state.value?.jobs.find(j => j.id === id)
  const body = reason === 'stalled' ? `Stalled: ${state.value?.errors[id] ?? ''}` : 'Needs your call'
  const n = new Notification(job ? `${id}: ${job.title}` : id, { body, tag: id })
  n.onclick = () => {
    window.focus()
    void navigateTo({ path: '/', query: { job: id } })
    n.close()
  }
}

const projectName = computed(() => state.value?.project.split('/').pop() ?? '…')

const links = computed(() => [
  { label: 'Board', to: '/', icon: 'i-lucide-kanban' },
  { label: 'Inbox', to: '/inbox', icon: 'i-lucide-inbox', badge: waiting.value || undefined },
  { label: 'Activity', to: '/activity', icon: 'i-lucide-activity' },
  { label: 'New request', to: '/new', icon: 'i-lucide-plus' },
  { label: 'Settings', to: '/settings', icon: 'i-lucide-settings' },
  { label: 'Setup', to: '/setup', icon: 'i-lucide-wrench', badge: failing.value ? { label: String(failing.value), color: 'warning' as const } : undefined }
])
</script>

<template>
  <UApp>
    <UHeader
      :title="`Factory · ${projectName}`"
      to="/"
    >
      <UNavigationMenu :items="links" />

      <template #right>
        <UTooltip :text="connected ? 'Live' : 'Disconnected'">
          <UChip
            :color="connected ? 'success' : 'error'"
            standalone
            inset
          >
            <span class="sr-only">{{ connected ? 'Live' : 'Disconnected' }}</span>
          </UChip>
        </UTooltip>
        <UButton
          v-if="!state?.draining"
          icon="i-lucide-play"
          label="Run queue"
          @click="act('/api/run')"
        />
        <UButton
          v-else
          icon="i-lucide-pause"
          label="Pause"
          color="neutral"
          variant="subtle"
          @click="act('/api/pause')"
        />
        <UColorModeButton />
      </template>
    </UHeader>

    <UMain class="h-[calc(100dvh-var(--ui-header-height))] min-h-0 flex flex-col">
      <UAlert
        v-if="reconnecting"
        role="status"
        aria-live="polite"
        title="Reconnecting…"
        icon="i-lucide-wifi-off"
        color="warning"
        variant="subtle"
        class="shrink-0 rounded-none"
        :ui="{ title: 'text-amber-800 dark:text-amber-300' }"
      />
      <UScrollArea
        class="flex-1 min-h-0"
        :ui="{ viewport: 'h-full' }"
      >
        <NuxtPage />
      </UScrollArea>
    </UMain>
  </UApp>
</template>
