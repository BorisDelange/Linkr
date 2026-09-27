/** The `linkr` server with all its tools — one definition behind both transports. */
import { McpServer } from '@modelcontextprotocol/server'
import { registerCohortExtraTools } from './tools-cohorts-extra.js'
import { registerConceptTools } from './tools-concepts.js'
import { registerContextTools } from './tools-context.js'
import { registerDocsTools } from './tools-docs.js'
import { registerDeriveTools } from './tools-derive.js'
import { registerDqTools } from './tools-dq.js'
import { registerEtlTools } from './tools-etl.js'
import { registerGitTools } from './tools-git.js'
import { registerIdeTools } from './tools-ide.js'
import { registerLabExtraTools } from './tools-lab-extra.js'
import { registerLabTools } from './tools-lab.js'
import { registerMappingExtraTools } from './tools-mapping-extra.js'
import { registerMappingTools } from './tools-mapping.js'
import { registerRuntimeTools } from './tools-runtime.js'
import { registerWarehouseTools } from './tools-warehouse.js'
import { registerWikiTools } from './tools-wiki.js'
import { registerWorkspaceTools } from './tools-workspace.js'

type Register = (server: McpServer) => void

/** Tool families a deployment can pick with `LINKR_MCP_TOOLSETS` (comma-separated;
 *  unset or `all` = every one). `get_ui_context` and the docs tools are always on. */
export const TOOLSETS: Record<string, Register[]> = {
  workspace: [registerWorkspaceTools],
  warehouse: [registerWarehouseTools, registerCohortExtraTools, registerConceptTools, registerDeriveTools],
  dq: [registerDqTools],
  lab: [registerLabTools, registerLabExtraTools],
  ide: [registerIdeTools, registerRuntimeTools],
  mapping: [registerMappingTools, registerMappingExtraTools],
  etl: [registerEtlTools],
  wiki: [registerWikiTools],
  git: [registerGitTools],
}

export function selectedToolsets(value: string | undefined): string[] {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.length === 0 || names.includes('all')) return Object.keys(TOOLSETS)
  const unknown = names.filter((n) => !TOOLSETS[n])
  if (unknown.length) {
    throw new Error(`LINKR_MCP_TOOLSETS: unknown toolset(s) ${unknown.join(', ')}; known: ${Object.keys(TOOLSETS).join(', ')}.`)
  }
  return names
}

// Read once at import, so a typo stops the server at start-up rather than on each request.
const configured = selectedToolsets(process.env.LINKR_MCP_TOOLSETS)

export function buildServer(toolsets = configured): McpServer {
  const server = new McpServer({ name: 'linkr', version: '0.1.0' })
  registerContextTools(server)
  registerDocsTools(server)
  for (const name of toolsets) for (const register of TOOLSETS[name]) register(server)
  return server
}
