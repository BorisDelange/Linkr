/** The way to every tool not exposed directly: find it, then run it by its kind. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import {
  RUN_TOOL, checkArguments, formatIndex, formatToolCard, inputJsonSchema, kindOf, searchTools,
  type CatalogTool, type ToolKind,
} from './gateway.js'
import { DESTRUCTIVE, READ, WRITE, failure, text, type Server } from './shared.js'

/** What each family covers, so the model knows what to look for without a first search. */
export const FAMILIES: Record<string, string> = {
  context: 'where the user is, projects, documentation',
  workspace: 'workspaces, create/edit projects, link and create databases, schema presets',
  warehouse: 'database exploration, SQL, cohorts (criteria, runs, reports, freeze, ATLAS import), concept sets and lists, derived databases',
  dq: 'data quality: rule sets, custom checks, scans and their history',
  lab: 'datasets (edit cells, rows, columns, history), analyses, dashboards (tabs, widgets, filters), Pipeline diagram, Patient data boards, workspace plugins',
  ide: 'IDE scripts, R/Python runs, kernel sessions, background jobs, package environments',
  mapping: 'concept mapping: mapping projects, source concepts, vocabulary search, AI suggestions, mappings and their review, custom concept ids',
  etl: 'ETL pipelines and SQL script collections: files, run order, runs',
  wiki: 'workspace wiki, data catalogs, READMEs',
  git: 'git versioning, read-only: status, diffs, sync state, branches',
}

const RUN_ANNOTATIONS = { read: READ, write: WRITE, delete: DESTRUCTIVE } as const

const RUN_WHAT: Record<ToolKind, string> = {
  read: 'a Linkr tool that only reads',
  write: 'a Linkr tool that creates or changes something (not a deletion)',
  delete: 'a Linkr tool that deletes or discards something. Ask the user first',
}

export function registerGatewayTools(server: Server, catalog: CatalogTool[], direct: Set<string>): void {
  const byName = new Map(catalog.map((t) => [t.name, t]))
  const families = Object.entries(FAMILIES).map(([k, v]) => `${k} (${v})`).join('; ')

  server.registerTool('find_linkr_tools', {
    description: 'Linkr has more tools than the ones listed here. Search them by what you want to do, in English '
      + '(e.g. "add a data quality check", "review mappings", "create a project", "install an R package"), or get '
      + 'given tools by name. Returns each tool\'s description, its arguments as JSON Schema, and which of '
      + 'run_linkr_read_tool / run_linkr_write_tool / run_linkr_delete_tool calls it. With no argument, lists every '
      + `tool name by family. Families: ${families}.`,
    annotations: READ,
    inputSchema: fromJsonSchema<{ query?: string; names?: string[]; limit?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in English.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names, e.g. from the index.' },
        limit: { type: 'number', description: 'Tools returned for a query, default 5, max 15.' },
      },
    }),
  }, async ({ query, names, limit }) => {
    if (names?.length) {
      const unknown = names.filter((n) => !byName.has(n))
      const found = names.filter((n) => byName.has(n)).map((n) => formatToolCard(byName.get(n)!))
      const note = unknown.length ? `\n\nUnknown: ${unknown.join(', ')} — call find_linkr_tools with no argument for the index.` : ''
      return found.length ? text(found.join('\n\n') + note) : failure(note.trim())
    }
    if (!query?.trim()) return text(formatIndex(catalog, direct))
    const hits = searchTools(catalog, query, Math.min(Math.max(1, Math.floor(limit ?? 5)), 15))
    if (hits.length === 0) {
      return failure(`No tool matches "${query}". Rephrase in English, or call find_linkr_tools with no argument for the index.`)
    }
    return text(hits.map(formatToolCard).join('\n\n'))
  })

  for (const kind of ['read', 'write', 'delete'] as const) {
    server.registerTool(RUN_TOOL[kind], {
      description: `Run ${RUN_WHAT[kind]}, found with find_linkr_tools, by its name and its arguments.`,
      annotations: RUN_ANNOTATIONS[kind],
      inputSchema: fromJsonSchema<{ tool: string; arguments?: Record<string, unknown> }>({
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The tool name, as find_linkr_tools gives it.' },
          arguments: { type: 'object', description: 'Its arguments, following its JSON Schema.' },
        },
        required: ['tool'],
      }),
    }, async ({ tool: name, arguments: args }) => {
      const tool = byName.get(name)
      if (!tool) {
        const like = searchTools(catalog, name.replace(/_/g, ' '), 3).map((t) => t.name)
        return failure(`No Linkr tool "${name}".${like.length ? ` Did you mean ${like.join(', ')}?` : ''} See find_linkr_tools.`)
      }
      const actual = kindOf(tool.config.annotations)
      if (actual !== kind) return failure(`${name} is a ${actual} tool: call it with ${RUN_TOOL[actual]}.`)
      const checked = await checkArguments(tool, args)
      if ('issues' in checked) {
        return failure(`Arguments do not fit ${name}:\n- ${checked.issues.join('\n- ')}\n`
          + `Its arguments (JSON Schema): ${JSON.stringify(inputJsonSchema(tool))}`)
      }
      return tool.handler(checked.value)
    })
  }
}
