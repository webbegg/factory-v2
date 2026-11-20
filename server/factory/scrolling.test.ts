// The shared "is scrolling" state behind the hidden-until-scroll scrollbars.
import { describe, expect, test } from 'bun:test'
import { scrollMarker } from '../../app/utils/scrolling'

function fakeTimers() {
  let now = 0
  let next = 0
  const pending = new Map<number, { at: number, fn: () => void }>()
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        pending.set(++next, { at: now + ms, fn })
        return next
      },
      clear: (id: number) => {
        pending.delete(id)
      }
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...pending]) {
        if (t.at > now) continue
        pending.delete(id)
        t.fn()
      }
    }
  }
}

function fakeElement() {
  const attrs = new Set<string>()
  return {
    setAttribute: (name: string) => attrs.add(name),
    removeAttribute: (name: string) => attrs.delete(name),
    scrolling: () => attrs.has('data-scrolling')
  }
}

describe('scrollMarker', () => {
  test('marking sets data-scrolling', () => {
    const { timers } = fakeTimers()
    const el = fakeElement()
    scrollMarker(timers, 1000)(el)
    expect(el.scrolling()).toBe(true)
  })

  test('a second scroll within the timeout extends it', () => {
    const { timers, advance } = fakeTimers()
    const el = fakeElement()
    const mark = scrollMarker(timers, 1000)
    mark(el)
    advance(800)
    mark(el)
    advance(800)
    expect(el.scrolling()).toBe(true)
    advance(200)
    expect(el.scrolling()).toBe(false)
  })

  test('the attribute is removed after the timeout', () => {
    const { timers, advance } = fakeTimers()
    const el = fakeElement()
    scrollMarker(timers, 1000)(el)
    advance(999)
    expect(el.scrolling()).toBe(true)
    advance(1)
    expect(el.scrolling()).toBe(false)
  })

  test('each element keeps its own timeout', () => {
    const { timers, advance } = fakeTimers()
    const a = fakeElement()
    const b = fakeElement()
    const mark = scrollMarker(timers, 1000)
    mark(a)
    advance(600)
    mark(b)
    advance(400)
    expect(a.scrolling()).toBe(false)
    expect(b.scrolling()).toBe(true)
  })
})
