#!/usr/bin/env -S npx tsx
/**
 * `linkr` — drive a RUNNING Linkr instance from any MCP client.
 *
 * Unlike the files server (`../files/server.ts`), every tool here acts through the REST
 * API of a live server, as the user whose credentials it holds (see `api.ts`), so
 * the server re-checks each permission. Query building is not reimplemented: the
 * cohort and concept SQL come from the app's own builders, imported as-is.
 *
 * Proof of concept, cohorts first — see docs/planning/ai-agents-plan.md §4.
 *
 * stdout is the JSON-RPC channel — never write to it. Diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import './env.js'

// Imported after the env file is loaded: the API client reads it.
const { buildServer } = await import('./build.js')

process.on('uncaughtException', (e) => { console.error(e) })
await buildServer().connect(new StdioServerTransport())
console.error('linkr MCP (live) ready')
