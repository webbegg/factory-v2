<script setup lang="ts">
import type { AgentName } from '~~/server/factory/agents/prompts'
import type { ConfigUpdate } from '~~/server/factory/config'
import type { FactoryConfig, Risk } from '~~/server/factory/types'

const { act } = useBoard()
const notifications = useNotifications()
const { supported, permission, active: notifying } = notifications
onMounted(notifications.recheckPermission)
const notifyHelp = computed(() => {
  if (!supported) return 'This browser doesn\'t support notifications.'
  if (permission.value === 'denied') return 'Notifications are blocked for this site in the browser settings.'
  return 'Notifies this browser, while the board is open, when a job needs your call or stalls.'
})
function toggleNotifications(on: boolean) {
  if (on) void notifications.enable()
  else notifications.disable()
}

const { data, error } = await useFetch<{ config: FactoryConfig, prompts: { name: AgentName, overridden: boolean, addendum: boolean }[] }>('/api/settings')

const form = ref<ConfigUpdate | null>(null)
const paths = ref('')
const busy = ref(false)
const saved = ref(false)

function fill(config: FactoryConfig) {
  const { concurrency, maxRounds, baseBranch, mergeMethod, models, routing, protectedPaths } = structuredClone(config)
  form.value = { concurrency, maxRounds, baseBranch, mergeMethod, models, routing, protectedPaths }
  paths.value = protectedPaths.join('\n')
}
watch(() => data.value?.config, (config) => {
  if (config) fill(config)
}, { immediate: true })

const risks: Risk[] = ['low', 'medium', 'high']
const modelKeys = ['intake', 'spec', 'builder', 'approver'] as const
const mergeMethods = ['merge', 'squash', 'rebase']

async function save() {
  if (!form.value) return
  busy.value = true
  const protectedPaths = paths.value.split('\n').map(p => p.trim()).filter(Boolean)
  const res = await act<{ config: FactoryConfig }>('/api/settings/config', { ...form.value, protectedPaths })
  busy.value = false
  if (!res) return
  fill(res.config)
  saved.value = true
}
</script>

<template>
  <UContainer class="max-w-2xl py-6 space-y-4">
    <UAlert
      v-if="error && !data"
      color="error"
      variant="subtle"
      title="Couldn't load settings"
      :description="error.statusMessage ?? error.message"
    />
    <UCard v-if="form">
      <!-- novalidate: the server's message, not the browser's popup, explains a bad value -->
      <form
        class="space-y-4"
        novalidate
        @submit.prevent="save"
      >
        <div>
          <h1 class="text-lg font-semibold text-highlighted">
            Settings
          </h1>
          <p class="text-sm text-muted">
            Edits <code>.factory/config.json</code>. New values apply to the running factory right away; jobs already running keep their round limit.
          </p>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField label="Concurrency">
            <UInput
              v-model.number="form.concurrency"
              type="number"
              :min="1"
              :max="8"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Max rounds">
            <UInput
              v-model.number="form.maxRounds"
              type="number"
              :min="1"
              :max="10"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Base branch">
            <UInput
              v-model="form.baseBranch"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Merge method">
            <USelect
              v-model="form.mergeMethod"
              :items="mergeMethods"
              class="w-full"
            />
          </UFormField>
        </div>

        <h2 class="text-sm font-semibold text-highlighted">
          Models
        </h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField
            v-for="key in modelKeys"
            :key="key"
            :label="key"
          >
            <UInput
              v-model="form.models[key]"
              class="w-full"
            />
          </UFormField>
        </div>

        <h2 class="text-sm font-semibold text-highlighted">
          Reviewers by risk
        </h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <template
            v-for="risk in risks"
            :key="risk"
          >
            <UFormField
              v-for="(_, lens) in form.routing[risk]"
              :key="`${risk}-${lens}`"
              :label="`${risk} · ${lens}`"
            >
              <UInput
                v-model="form.routing[risk][lens]"
                class="w-full"
              />
            </UFormField>
          </template>
        </div>

        <UFormField
          label="Protected paths"
          help="One glob per line. No job may modify or delete a matching file."
        >
          <UTextarea
            v-model="paths"
            :rows="5"
            class="w-full"
          />
        </UFormField>

        <UButton
          type="submit"
          label="Save"
          :loading="busy"
        />

        <UAlert
          v-if="saved"
          color="warning"
          variant="subtle"
          title="Saved. Commit .factory/config.json"
          description=".factory/config.json is committed in the repo, so commit this change too."
        />
      </form>
    </UCard>

    <UCard>
      <div class="space-y-3">
        <h2 class="text-sm font-semibold text-highlighted">
          Notifications
        </h2>
        <USwitch
          :model-value="notifying"
          :disabled="!supported || permission === 'denied'"
          label="Browser notifications"
          :description="notifyHelp"
          @update:model-value="toggleNotifications"
        />
      </div>
    </UCard>

    <UCard v-if="data">
      <div class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-highlighted">
            Agents
          </h2>
          <p class="text-sm text-muted">
            <code>.factory/agents/&lt;name&gt;.md</code> replaces an agent's prompt;
            <code>.factory/agents/&lt;name&gt;.append.md</code> is added to it under "This project".
            The override wins if both exist.
          </p>
        </div>
        <ul class="space-y-2">
          <li
            v-for="p in data.prompts"
            :key="p.name"
            class="flex items-center gap-2 text-sm"
          >
            <span class="text-highlighted">{{ p.name }}</span>
            <span class="ms-auto flex gap-1">
              <UBadge
                v-if="p.overridden"
                label="overridden"
                color="primary"
                variant="subtle"
              />
              <UBadge
                v-if="p.addendum"
                label="addendum"
                color="primary"
                variant="subtle"
              />
              <UBadge
                v-if="!p.overridden && !p.addendum"
                label="built-in"
                color="neutral"
                variant="subtle"
              />
            </span>
          </li>
        </ul>
      </div>
    </UCard>
  </UContainer>
</template>
