// Human actions on one job: feedback, reject, answer (need { text }), merge, retry, cancel,
// rerun (Run again: archives a rejected job's folder so its issue can get a fresh job).
export default defineEventHandler(async (event) => {
  const f = await useFactory()
  const id = getRouterParam(event, 'id')!
  const action = getRouterParam(event, 'action')
  const o = f.orchestrator
  switch (action) {
    case 'feedback': {
      const text = await readText(event)
      return guarded(async () => ({ job: await o.feedback(id, text) }))
    }
    case 'reject': {
      const text = await readText(event)
      return guarded(async () => ({ job: await o.reject(id, text) }))
    }
    case 'answer': {
      const text = await readText(event)
      return guarded(async () => ({ job: await o.answer(id, text, (n, body) => f.github.reply(n, body)) }))
    }
    case 'merge':
      return guarded(async () => ({ job: await o.approve(id) }))
    case 'retry':
      await guarded(() => f.store.load(id))
      o.retry(id)
      return { ok: true }
    case 'rerun':
      return guarded(() => o.runAgain(id))
    case 'cancel':
      o.cancel(id)
      return { ok: true }
    default:
      throw createError({ statusCode: 404, statusMessage: `unknown action ${action}` })
  }
})
