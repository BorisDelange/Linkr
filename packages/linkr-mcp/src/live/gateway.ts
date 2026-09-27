/**
 * The tool catalogue behind the gateway: every tool is registered into it, only a
 * core set is exposed to the client as such, and the rest is reached through
 * `find_linkr_tools` + `run_linkr_*_tool`. The client's tool list never changes, so
 * nothing needs configuring there, and the definitions sent with every turn stay small.
 */
import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'
import type { ToolResult } from './shared.js'

export type ToolKind = 'read' | 'write' | 'delete'

export interface CatalogTool {
  name: string
  toolset: string
  config: {
    title?: string
    description?: string
    annotations?: ToolAnnotations
    inputSchema?: StandardSchemaWithJSON
  }
  handler: (args: unknown) => Promise<ToolResult>
}

/** The tools a register function declares, collected instead of exposed. */
export function captureTools(toolset: string, registers: ((server: McpServer) => void)[]): CatalogTool[] {
  const out: CatalogTool[] = []
  const collector = {
    registerTool: (name: string, config: CatalogTool['config'], handler: CatalogTool['handler']) => {
      out.push({ name, toolset, config, handler })
    },
  } as unknown as McpServer
  for (const register of registers) register(collector)
  return out
}

/** Which run tool may call it: the client approves by that tool's annotations. */
export function kindOf(annotations: ToolAnnotations | undefined): ToolKind {
  if (annotations?.destructiveHint) return 'delete'
  return annotations?.readOnlyHint ? 'read' : 'write'
}

export const RUN_TOOL: Record<ToolKind, string> = {
  read: 'run_linkr_read_tool',
  write: 'run_linkr_write_tool',
  delete: 'run_linkr_delete_tool',
}

const words = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2)

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'from', 'by', 'is', 'it', 'its', 'my', 'this', 'that', 'de', 'la', 'le', 'les', 'des', 'un', 'une', 'du', 'et'])

/** Same word, or one starts the other (≥ 4 letters): "check" ~ "checks", "mapping" ~ "mappings". */
const near = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)))

/** Tools ranked for a free-text need: name words weigh most, then the family, then the description. */
export function searchTools(catalog: CatalogTool[], query: string, limit = 5): CatalogTool[] {
  const terms = [...new Set(words(query).filter((w) => !STOP.has(w)))]
  if (terms.length === 0) return []
  const scored = catalog.map((tool) => {
    const nameWords = tool.name.split('_')
    const descWords = new Set(words(`${tool.config.title ?? ''} ${tool.config.description ?? ''}`))
    let score = 0
    let matched = 0
    for (const t of terms) {
      const inName = nameWords.some((w) => near(w, t))
      const inSet = near(tool.toolset, t)
      const inDesc = [...descWords].some((w) => near(w, t))
      if (inName) score += 4
      if (inSet) score += 2
      if (inDesc) score += 1
      if (inName || inSet || inDesc) matched++
    }
    // Covering more of the request beats repeating one word.
    return { tool, score: score + matched * 2 }
  })
  return scored
    .filter((s) => s.score > 2)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((s) => s.tool)
}

export function inputJsonSchema(tool: CatalogTool): Record<string, unknown> {
  const std = tool.config.inputSchema?.['~standard']
  return (std?.jsonSchema.input({ target: 'draft-2020-12' }) as Record<string, unknown> | undefined) ?? { type: 'object' }
}

/** A tool as the model needs it to call it through the gateway. */
export function formatToolCard(tool: CatalogTool): string {
  const kind = kindOf(tool.config.annotations)
  return [
    `## ${tool.name} — ${kind}, call with ${RUN_TOOL[kind]} (family: ${tool.toolset})`,
    tool.config.description ?? '',
    `arguments (JSON Schema): ${JSON.stringify(inputJsonSchema(tool))}`,
  ].join('\n')
}

/** Every tool name by family, marking those the client already sees directly. */
export function formatIndex(catalog: CatalogTool[], direct: Set<string>): string {
  const byFamily = new Map<string, string[]>()
  for (const t of catalog) {
    const list = byFamily.get(t.toolset) ?? []
    list.push(direct.has(t.name) ? `${t.name}*` : t.name)
    byFamily.set(t.toolset, list)
  }
  return [
    'All Linkr tools by family (* = also available directly). Get the arguments of one with find_linkr_tools({ names: [...] }).',
    ...[...byFamily].map(([family, names]) => `- ${family}: ${names.join(', ')}`),
  ].join('\n')
}

/** Validate arguments against the tool's own schema; the issues, readable, when they do not fit. */
export async function checkArguments(tool: CatalogTool, args: unknown): Promise<{ value: unknown } | { issues: string[] }> {
  const std = tool.config.inputSchema?.['~standard']
  if (!std) return { value: args ?? {} }
  const result = await std.validate(args ?? {})
  if (result.issues) return { issues: result.issues.map((i) => i.message) }
  return { value: result.value }
}
