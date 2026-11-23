// A per-browser opt-in: browser permission belongs to one browser, while
// .factory/config.json is committed and shared, so the flag lives in localStorage.
const KEY = 'factory:notify'

const supported = import.meta.client && 'Notification' in window
const permission = ref<NotificationPermission>(supported ? Notification.permission : 'default')
const enabled = ref(import.meta.client && localStorage.getItem(KEY) === 'on')

/** The browser-notification opt-in, shared by Settings and the notifier in app.vue. */
export function useNotifications() {
  /** Asks for permission (only ever from the Settings switch) and stores the flag only when granted. */
  async function enable() {
    if (!supported) return
    permission.value = await Notification.requestPermission()
    enabled.value = permission.value === 'granted'
    if (enabled.value) localStorage.setItem(KEY, 'on')
  }

  function disable() {
    enabled.value = false
    localStorage.removeItem(KEY)
  }

  /** Picks up a permission changed in the browser's site settings since load. */
  function recheckPermission() {
    if (supported) permission.value = Notification.permission
  }

  const active = computed(() => enabled.value && permission.value === 'granted')

  return { supported, permission, enabled, active, enable, disable, recheckPermission }
}
