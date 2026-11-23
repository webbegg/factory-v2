// The backoff the board waits before reopening a closed event stream.
import { describe, expect, test } from 'bun:test'
import { reconnectDelay } from '../../app/utils/reconnect'

describe('reconnectDelay', () => {
  test('waits 1s, 2s, then 5s for the first retries', () => {
    expect(reconnectDelay(0)).toBe(1000)
    expect(reconnectDelay(1)).toBe(2000)
    expect(reconnectDelay(2)).toBe(5000)
  })

  test('caps at 10s from the fourth retry on', () => {
    expect(reconnectDelay(3)).toBe(10000)
    expect(reconnectDelay(50)).toBe(10000)
  })
})
