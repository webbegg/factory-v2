import type { FactoryEvent } from '../factory/orchestrator'

// Server-sent events: every job change, agent activity line, error and log.
// A plain ReadableStream instead of h3's event stream: when a client leaves,
// h3's internal pipe rejects with an unhandled AbortError that kills the
// process under Bun. Here a departed client only triggers `cancel`.
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const encoder = new TextEncoder()
  let stop = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const push = (data: unknown) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          stop()
        }
      }
      const listener = (e: FactoryEvent) => push(e)
      // Bun.serve closes a request after 10s without bytes; keep the stream warm.
      const ping = setInterval(() => push({ type: 'ping' }), 5000)
      stop = () => {
        if (!open) return
        open = false
        clearInterval(ping)
        f.orchestrator.off('event', listener)
      }
      f.orchestrator.on('event', listener)
      push({ type: 'hello' })
    },
    cancel() {
      stop()
    }
  })
  setResponseHeaders(event, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  })
  return body
})
