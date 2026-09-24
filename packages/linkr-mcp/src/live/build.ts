/** The `linkr` server with all its tools — one definition behind both transports. */
import { McpServer } from '@modelcontextprotocol/server'
import { registerConceptTools } from './tools-concepts.js'
import { registerContextTools } from './tools-context.js'
import { registerDeriveTools } from './tools-derive.js'
import { registerIdeTools } from './tools-ide.js'
import { registerLabTools } from './tools-lab.js'
import { registerMappingTools } from './tools-mapping.js'
import { registerWarehouseTools } from './tools-warehouse.js'

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'linkr', version: '0.1.0' })
  registerContextTools(server)
  registerWarehouseTools(server)
  registerConceptTools(server)
  registerLabTools(server)
  registerIdeTools(server)
  registerMappingTools(server)
  registerDeriveTools(server)
  return server
}
