// One capture-phase listener covers every scroll region, including the
// generated `.md pre` blocks that no component owns.
export default defineNuxtPlugin(() => {
  const mark = scrollMarker<number>({
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: id => window.clearTimeout(id)
  }, SCROLL_IDLE_MS)
  document.addEventListener('scroll', (e) => {
    if (e.target instanceof Element) mark(e.target)
  }, { capture: true, passive: true })
})
