/** The project's Pipeline diagram: databases → cohorts → scripts → datasets → dashboards. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type { Pipeline, PipelineNodeType } from '@/types'
import { bilingual } from './lab.js'
import {
  PIPELINE_NODE_TYPES, checkNodeFields, connectError, describePipeline, newPipelineNode, nextNodePosition, nodeData,
  withoutNode, type NodeFields,
} from './lab-extra.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'
import { q } from './lab-rest.js'

async function projectPipeline(projectUid: string, create: boolean): Promise<Pipeline | null> {
  const [existing] = await api.request<Pipeline[]>('GET', `/pipelines?projectUid=${q(projectUid)}`)
  if (existing || !create) return existing ?? null
  return api.request<Pipeline>('POST', '/pipelines', {
    id: randomUUID(), projectUid, name: bilingual('Main pipeline'), nodes: [], edges: [],
  })
}

const savePipeline = (p: Pipeline, nodes: Pipeline['nodes'], edges: Pipeline['edges']) =>
  api.request<Pipeline>('PATCH', `/pipelines/${q(p.id)}`, { nodes, edges })

/** Refuse links to entities the project does not have: the node panel would show
 *  an empty picker and the diagram a dangling reference. */
async function checkNodeLinks(projectUid: string, f: NodeFields): Promise<string | null> {
  if (f.dataSourceId) {
    const linked = (await api.getProject(projectUid)).linkedDataSourceIds ?? []
    if (!linked.includes(f.dataSourceId)) return `Database ${f.dataSourceId} is not linked to this project (see get_project_context).`
  }
  if (f.cohortId && !(await api.listCohorts(projectUid)).some((c) => c.id === f.cohortId)) {
    return `No cohort ${f.cohortId} in this project (see list_cohorts).`
  }
  if (f.dashboardId && !(await api.listDashboards(projectUid)).some((d) => d.id === f.dashboardId)) {
    return `No dashboard ${f.dashboardId} in this project (see list_dashboards).`
  }
  if (f.scripts?.length) {
    const paths = new Set((await api.listScripts(projectUid)).filter((s) => s.type === 'file').map((s) => s.path))
    const missing = f.scripts.filter((s) => !paths.has(s))
    if (missing.length) return `No script ${missing.join(', ')} in this project (see list_scripts).`
  }
  return null
}

const NODE_FIELD_SCHEMA = {
  label: { type: 'string', description: 'Shown on the node. Default: its type.' },
  database_id: { type: 'string', description: 'database node: a database linked to the project.' },
  cohort_id: { type: 'string', description: 'cohort node: one of the project\'s cohorts.' },
  dashboard_id: { type: 'string', description: 'dashboard node: one of the project\'s dashboards.' },
  dataset_name: { type: 'string', description: 'dataset node: the output dataset\'s name.' },
  scripts: { type: 'array', items: { type: 'string' }, description: 'scripts node: IDE script paths, in run order (replaces the list).' },
} as const

interface NodeArgs {
  label?: string; database_id?: string; cohort_id?: string; dashboard_id?: string; dataset_name?: string; scripts?: string[]
}

const nodeFields = (a: NodeArgs): NodeFields => ({
  label: a.label, dataSourceId: a.database_id, cohortId: a.cohort_id, dashboardId: a.dashboard_id,
  datasetName: a.dataset_name, scripts: a.scripts,
})

export function registerPipelineTools(server: Server): void {
  server.registerTool('describe_pipeline', {
    description:
      'A project\'s Pipeline: the diagram on its Pipeline page showing how its data flows — database, cohort, '
      + 'scripts, dataset and dashboard nodes, linked by arrows, optionally inside groups. It documents the flow; '
      + 'it does not run anything.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const p = await projectPipeline(project_uid, false)
    return text(p ? describePipeline(p, loc(p.name)) : 'This project has no pipeline yet (add_pipeline_node creates it).')
  }))

  server.registerTool('add_pipeline_node', {
    description: 'Add a node to the project\'s Pipeline diagram (created on first use), optionally linked to what it '
      + 'stands for, inside a group, and connected from an existing node. Placed right of the others.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<NodeArgs & {
      project_uid: string; type: PipelineNodeType; group_id?: string; from_node_id?: string; position?: { x: number; y: number }
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        type: { type: 'string', enum: PIPELINE_NODE_TYPES },
        ...NODE_FIELD_SCHEMA,
        group_id: { type: 'string', description: 'A group node to place it in.' },
        from_node_id: { type: 'string', description: 'Draw an arrow from this node to the new one.' },
        position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      required: ['project_uid', 'type'],
    }),
  }, guard(async (args) => {
    const fields = nodeFields(args)
    const misplaced = checkNodeFields(args.type, fields)
    if (misplaced) return failure(misplaced)
    const bad = await checkNodeLinks(args.project_uid, fields)
    if (bad) return failure(bad)
    const p = (await projectPipeline(args.project_uid, true))!
    if (args.group_id && !p.nodes.some((n) => n.id === args.group_id && n.data.type === 'group')) {
      return failure(`No group node ${args.group_id} (see describe_pipeline).`)
    }
    const id = randomUUID()
    const position = args.position ?? (args.group_id ? { x: 20, y: 40 } : nextNodePosition(p.nodes))
    const node = newPipelineNode(id, args.type, fields, position, randomUUID, args.group_id)
    const nodes = [...p.nodes, node]
    const edges = [...p.edges]
    if (args.from_node_id) {
      const err = connectError({ nodes, edges }, args.from_node_id, id)
      if (err) return failure(err)
      edges.push({ id: randomUUID(), source: args.from_node_id, target: id })
    }
    await savePipeline(p, nodes, edges)
    return text(`Added ${args.type} node "${node.data.label}" — node_id: ${id}`)
  }))

  server.registerTool('update_pipeline_node', {
    description: 'Change a Pipeline node: its label or what it links to (scripts replaces the node\'s script list).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<NodeArgs & { project_uid: string; node_id: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, node_id: { type: 'string' }, ...NODE_FIELD_SCHEMA },
      required: ['project_uid', 'node_id'],
    }),
  }, guard(async (args) => {
    const p = await projectPipeline(args.project_uid, false)
    const node = p?.nodes.find((n) => n.id === args.node_id)
    if (!p || !node) return failure(`No node ${args.node_id} in this project's pipeline (see describe_pipeline).`)
    const fields = nodeFields(args)
    const misplaced = checkNodeFields(node.data.type, fields)
    if (misplaced) return failure(misplaced)
    const bad = await checkNodeLinks(args.project_uid, fields)
    if (bad) return failure(bad)
    const data = nodeData(fields, randomUUID)
    if (Object.keys(data).length === 0) return failure('Nothing to change.')
    await savePipeline(p, p.nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, ...data } } : n)), p.edges)
    return text(`Updated node ${node.id}.`)
  }))

  server.registerTool('remove_pipeline_node', {
    description: 'Remove a node from the Pipeline diagram, with its arrows (a removed group\'s nodes stay, ungrouped). '
      + 'Only the diagram changes — the database, cohort or dataset it stood for is untouched.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; node_id: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, node_id: { type: 'string' } }, required: ['project_uid', 'node_id'],
    }),
  }, guard(async ({ project_uid, node_id }) => {
    const p = await projectPipeline(project_uid, false)
    if (!p?.nodes.some((n) => n.id === node_id)) return failure(`No node ${node_id} (see describe_pipeline).`)
    const g = withoutNode(p, node_id)
    await savePipeline(p, g.nodes, g.edges)
    return text(`Removed node ${node_id}.`)
  }))

  server.registerTool('link_pipeline_nodes', {
    description: 'Draw an arrow between two Pipeline nodes (data flows from source to target), or remove it with unlink.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; source_node_id: string; target_node_id: string; unlink?: boolean }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' }, source_node_id: { type: 'string' }, target_node_id: { type: 'string' },
        unlink: { type: 'boolean', description: 'Remove the arrow instead.' },
      },
      required: ['project_uid', 'source_node_id', 'target_node_id'],
    }),
  }, guard(async ({ project_uid, source_node_id, target_node_id, unlink }) => {
    const p = await projectPipeline(project_uid, false)
    if (!p) return failure('This project has no pipeline yet (add_pipeline_node).')
    if (unlink) {
      const edges = p.edges.filter((e) => !(e.source === source_node_id && e.target === target_node_id))
      if (edges.length === p.edges.length) return failure('No such arrow.')
      await savePipeline(p, p.nodes, edges)
      return text('Arrow removed.')
    }
    const err = connectError(p, source_node_id, target_node_id)
    if (err) return failure(err)
    await savePipeline(p, p.nodes, [...p.edges, { id: randomUUID(), source: source_node_id, target: target_node_id }])
    return text('Arrow added.')
  }))
}
