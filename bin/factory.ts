#!/usr/bin/env bun
import { main } from '../server/factory/cli'

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`factory: ${err.message}`)
  process.exit(1)
})
