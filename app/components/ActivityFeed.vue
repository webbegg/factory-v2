<script setup lang="ts">
const { state, feed } = useBoard()

const groups = computed(() => groupFeed(feed.value))
// Error and agent events carry raw job ids; only ids the board knows become links.
const known = computed(() => new Set(state.value?.jobs.map(j => j.id)))

// A UScrollArea instance; its scrolling element is on $el.
const scroller = ref<{ $el: HTMLElement } | null>(null)
const following = ref(true)
// New entries arrived since the user scrolled up.
const unseen = ref(false)
let lastTop = 0

function toBottom(smooth = false) {
  const el = scroller.value?.$el
  if (!el) return
  const motion = smooth && matchMedia('(prefers-reduced-motion: no-preference)').matches
  el.scrollTo({ top: el.scrollHeight, behavior: motion ? 'smooth' : 'auto' })
}

function onScroll() {
  const el = scroller.value?.$el
  if (!el) return
  if (atBottom(el)) {
    following.value = true
    unseen.value = false
  } else if (el.scrollTop < lastTop) {
    // Only an upward scroll stops following, so a smooth jump down doesn't stop it halfway.
    following.value = false
  }
  lastTop = el.scrollTop
}

function jump() {
  following.value = true
  unseen.value = false
  toBottom(true)
}

// Keyed on the newest id, not the length: once the cap is reached the length stops changing.
watch(() => feed.value.at(-1)?.id, () => {
  if (following.value) void nextTick(() => toBottom())
  else unseen.value = true
})

onMounted(() => toBottom())
</script>

<template>
  <UCard
    as="aside"
    aria-labelledby="activity-heading"
    class="flex min-h-0 flex-1 flex-col"
    :ui="{ body: 'relative flex min-h-0 flex-1 flex-col p-3 sm:p-3' }"
  >
    <p
      id="activity-heading"
      class="mb-2 text-xs font-semibold text-dimmed uppercase"
    >
      Activity
    </p>
    <!-- Wrapped, not as="ol": the viewport div would sit between the list and its items. -->
    <UScrollArea
      ref="scroller"
      tabindex="0"
      aria-label="Activity feed"
      class="min-h-0 flex-1"
      @scroll.passive="onScroll"
    >
      <ol class="space-y-3">
        <li
          v-for="g in groups"
          :key="g.key"
          class="space-y-1"
          :class="g.sender === 'factory' ? 'border-s-2 border-default ps-2' : ''"
        >
          <p class="flex items-baseline gap-1 text-xs text-muted">
            <span class="font-semibold text-muted">{{ g.sender }}</span>
            <template v-if="g.jobId">
              ·
              <ULink
                v-if="known.has(g.jobId)"
                :to="{ path: '/', query: { job: g.jobId } }"
                :active="false"
                class="min-w-0 truncate font-mono underline decoration-dotted underline-offset-2"
                :title="g.jobId"
              >
                {{ g.jobId }}
              </ULink>
              <span
                v-else
                class="min-w-0 truncate font-mono"
                :title="g.jobId"
              >{{ g.jobId }}</span>
            </template>
            <span class="ms-auto shrink-0 ps-2">{{ g.at }}</span>
          </p>
          <template
            v-for="e in g.entries"
            :key="e.id"
          >
            <p
              v-if="e.kind === 'tool'"
              class="truncate font-mono text-xs text-muted"
              :title="e.text"
            >
              {{ e.text }}
            </p>
            <p
              v-else-if="g.sender === 'factory'"
              class="text-xs break-words whitespace-pre-wrap"
              :class="e.kind === 'error' ? 'text-error' : 'text-muted'"
            >
              {{ e.text }}
            </p>
            <p
              v-else
              class="rounded-lg bg-elevated px-3 py-2 text-sm break-words whitespace-pre-wrap"
              :class="e.kind === 'error' ? 'text-error' : 'text-default'"
            >
              {{ e.text }}
            </p>
          </template>
        </li>
      </ol>
      <!-- Inside the region so it frames something to focus while idle. -->
      <p
        v-if="!feed.length"
        class="text-xs text-muted"
      >
        Activity appears here while the factory UI is open.
      </p>
    </UScrollArea>
    <UButton
      v-if="!following && unseen"
      label="Jump to latest"
      icon="i-lucide-arrow-down"
      size="xs"
      color="neutral"
      variant="solid"
      class="absolute bottom-5 left-1/2 -translate-x-1/2 shadow-md"
      @click="jump"
    />
  </UCard>
</template>
