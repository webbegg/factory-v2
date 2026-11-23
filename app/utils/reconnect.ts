// How long the board waits before reopening an event stream the browser closed.
const DELAYS = [1000, 2000, 5000, 10000]

/** Delay before retry number `attempt` (0-based, counted since the last successful open). */
export function reconnectDelay(attempt: number): number {
  return DELAYS[Math.min(attempt, DELAYS.length - 1)]!
}
