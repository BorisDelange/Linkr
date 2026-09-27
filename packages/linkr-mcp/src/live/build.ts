/** The `linkr` server with all its tools — one definition behind both transports. */
import { McpServer } from '@modelcontextprotocol/server'
import { captureTools, type CatalogTool } from './gateway.js'
import { registerCohortExtraTools } from './tools-cohorts-extra.js'
import { registerConceptTools } from './tools-concepts.js'
import { registerContextTools } from './tools-context.js'
import { registerDocsTools } from './tools-docs.js'
import { registerDeriveTools } from './tools-derive.js'
import { registerDqTools } from './tools-dq.js'
import { registerEtlTools } from './tools-etl.js'
import { registerGatewayTools } from './tools-gateway.js'
import { registerGitTools } from './tools-git.js'
import { registerIdeTools } from './tools-ide.js'
import { registerDashboardExtraTools } from './tools-lab-dashboards.js'
import { registerLabDatasetTools } from './tools-lab-datasets.js'
import { registerPatientBoardTools } from './tools-lab-patient.js'
import { registerPipelineTools } from './tools-lab-pipeline.js'
import { registerUserPluginTools } from './tools-lab-plugins.js'
import { registerLabTools } from './tools-lab.js'
import { registerMappingExtraTools } from './tools-mapping-extra.js'
import { registerMappingTools } from './tools-mapping.js'
import { registerRuntimeTools } from './tools-runtime.js'
import { registerWarehouseTools } from './tools-warehouse.js'
import { registerWikiTools } from './tools-wiki.js'
import { registerWorkspaceTools } from './tools-workspace.js'

type Register = (server: McpServer) => void

export const TOOLSETS: Record<string, Register[]> = {
  context: [registerContextTools, registerDocsTools],
  workspace: [registerWorkspaceTools],
  warehouse: [registerWarehouseTools, registerCohortExtraTools, registerConceptTools, registerDeriveTools],
  dq: [registerDqTools],
  lab: [
    registerLabTools, registerLabDatasetTools, registerPipelineTools, registerPatientBoardTools, registerDashboardExtraTools,
    registerUserPluginTools,
  ],
  ide: [registerIdeTools, registerRuntimeTools],
  mapping: [registerMappingTools, registerMappingExtraTools],
  etl: [registerEtlTools],
  wiki: [registerWikiTools],
  git: [registerGitTools],
}

/** Exposed directly: what most conversations use. Every other tool is one
 *  find_linkr_tools away, so this list is about context size, not access. */
export const CORE_TOOLS = [
  'get_ui_context', 'list_projects', 'get_project_context', 'search_docs', 'read_doc',
  'describe_database', 'search_concepts', 'run_sql',
  'list_cohorts', 'get_cohort', 'create_cohort', 'update_cohort', 'run_cohort',
  'list_datasets', 'describe_dataset', 'preview_dataset', 'create_dataset_from_query',
  'list_dashboards', 'describe_dashboard', 'create_dashboard', 'add_widget', 'update_widget',
  'list_plugins', 'describe_plugin',
  'list_scripts', 'read_script', 'write_script', 'run_code', 'run_script',
  'get_job_status',
]

export const CATALOG: CatalogTool[] = Object.entries(TOOLSETS).flatMap(([name, registers]) => captureTools(name, registers))

/** Families exposed directly on top of the core (`LINKR_MCP_TOOLSETS`, comma-separated;
 *  `all` = every tool, no gateway). Unset: the core only. */
export function selectedToolsets(value: string | undefined): string[] {
  const names = (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (names.includes('all')) return Object.keys(TOOLSETS)
  const unknown = names.filter((n) => !TOOLSETS[n])
  if (unknown.length) {
    throw new Error(`LINKR_MCP_TOOLSETS: unknown toolset(s) ${unknown.join(', ')}; known: all, ${Object.keys(TOOLSETS).join(', ')}.`)
  }
  return names
}

const INSTRUCTIONS = 'Linkr is a clinical data platform: projects link clinical databases (often OMOP) and hold '
  + 'cohorts, datasets, dashboards and scripts. Start from get_ui_context (where the user is) or list_projects. '
  + 'The tools listed are the common ones; many more exist (workspaces, data quality, ETL, concept mapping, wiki, '
  + 'environments, git…): find them with find_linkr_tools, then call them with run_linkr_read_tool, '
  + 'run_linkr_write_tool or run_linkr_delete_tool.'

// Read once at import, so a typo stops the server at start-up rather than on each request.
const configured = selectedToolsets(process.env.LINKR_MCP_TOOLSETS)

export function buildServer(toolsets = configured): McpServer {
  const everything = toolsets.length === Object.keys(TOOLSETS).length
  const direct = new Set([...CORE_TOOLS, ...CATALOG.filter((t) => toolsets.includes(t.toolset)).map((t) => t.name)])
  const server = new McpServer({ name: 'linkr', version: '0.1.0' }, everything ? {} : { instructions: INSTRUCTIONS })
  for (const tool of CATALOG) {
    if (direct.has(tool.name)) server.registerTool(tool.name, tool.config, tool.handler as never)
  }
  if (!everything) registerGatewayTools(server, CATALOG, direct)
  return server
}
