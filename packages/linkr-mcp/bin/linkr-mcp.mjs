#!/usr/bin/env node
// tsx only reads the tsconfig of the working directory, so the `@/` aliases would
// not resolve when this is launched from anywhere else.
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) })
await import('../src/live/server.ts')
