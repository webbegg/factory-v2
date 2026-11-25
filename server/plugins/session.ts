import { fixtureMode } from '../factory/service'
import { boardUrlAnnounced, sessionToken } from '../factory/session'

// `factory ui` prints the board URL itself; under `bun run dev` nothing else
// would, and without it the board can't reach its API.
export default defineNitroPlugin(() => {
  if (fixtureMode() || boardUrlAnnounced()) return
  const path = `/?token=${sessionToken()}`
  const port = process.env.NITRO_PORT ?? process.env.PORT
  console.log(port
    ? `factory board: http://localhost:${port}${path}`
    : `factory board: open ${path} on the dev server's address`)
})
