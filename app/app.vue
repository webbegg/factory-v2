<script setup lang="ts">
useHead({
  meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
  link: [{ rel: 'icon', href: '/favicon.ico' }],
  htmlAttrs: { lang: 'en' },
  title: 'Factory'
})

const { state, connected, connect, refresh, act } = useBoard()
const { checks, recheck } = useSetup()
onMounted(() => {
  connect()
  void refresh()
  void recheck()
})

const failing = computed(() => summarizeDoctor(checks.value).failures.length)

const waiting = computed(() => state.value?.jobs.filter(j => j.stage === 'needs-human' || j.stage === 'needs-info').length ?? 0)
const projectName = computed(() => state.value?.project.split('/').pop() ?? '…')

const links = computed(() => [
  { label: 'Board', to: '/', icon: 'i-lucide-kanban' },
  { label: 'Inbox', to: '/inbox', icon: 'i-lucide-inbox', badge: waiting.value || undefined },
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
          />
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

    <UMain class="h-[calc(100dvh-var(--ui-header-height))] min-h-0 overflow-y-auto">
      <NuxtPage />
    </UMain>
  </UApp>
</template>
