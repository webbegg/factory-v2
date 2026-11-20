// Scrollbars show only while their region scrolls: main.css styles
// [data-scrolling], and this sets it on a scroll and clears it once scrolling stops.

/** How long after the last scroll event a region counts as still scrolling. */
export const SCROLL_IDLE_MS = 1000

export interface Timers<T> {
  set: (fn: () => void, ms: number) => T
  clear: (id: T) => void
}

// The slice of Element this needs; the engine's tsconfig has no DOM types.
interface Marked {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

/** Returns `mark(el)`: sets data-scrolling on el, clearing it `idleMs` after the last mark. */
export function scrollMarker<T>(timers: Timers<T>, idleMs: number) {
  const pending = new Map<Marked, T>()
  return (el: Marked) => {
    const previous = pending.get(el)
    if (previous !== undefined) timers.clear(previous)
    else el.setAttribute('data-scrolling', '')
    pending.set(el, timers.set(() => {
      pending.delete(el)
      el.removeAttribute('data-scrolling')
    }, idleMs))
  }
}
