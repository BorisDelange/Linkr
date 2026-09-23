/** The `linkr` server with all its tools — one definition behind both transports. */
import { McpServer } from '@modelcontextprotocol/server'
import { registerContextTools } from './tools-context.js'
import { registerLabTools } from './tools-lab.js'
import { registerWarehouseTools } from './tools-warehouse.js'

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'linkr', version: '0.1.0' })
  registerContextTools(server)
  registerWarehouseTools(server)
  registerLabTools(server)
  return server
}
