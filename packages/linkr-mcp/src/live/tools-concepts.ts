/** Concept sets (workspace data dictionaries, read-only) and concept lists (project picks). */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { describeConceptSet, describeItems, editItems, toListItems, type ItemInput } from './concepts.js'
import { bilingual } from './lab.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'

const ITEMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      concept_id: { type: ['number', 'string'] }, name: { type: 'string' }, vocabulary: { type: 'string' }, code: { type: 'string' },
    },
    required: ['concept_id'],
  },
  description: 'Concepts, e.g. from search_concepts: [{"concept_id": 3047181, "name": "Lactate", "vocabulary": "LOINC", "code": "2524-7"}].',
} as const

export function registerConceptTools(server: Server) {
  server.registerTool('list_concept_sets', {
    description: 'Concept sets of the project\'s workspace: imported data dictionaries (OHDSI expressions), '
      + 'read-only. get_concept_set gives the concept ids to reuse in a cohort\'s concept criterion.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; search?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        search: { type: 'string', description: 'Case-insensitive filter on name / category.' },
      },
      required: ['project_uid'],
    }),
  }, guard(async ({ project_uid, search }) => {
    const project = await api.getProject(project_uid)
    const q = search?.toLowerCase()
    const sets = (await api.listConceptSets(project.workspaceId ?? undefined))
      .filter((s) => !q || `${s.name} ${s.category ?? ''} ${s.subcategory ?? ''}`.toLowerCase().includes(q))
    if (sets.length === 0) return text(q ? `No concept set matches "${search}".` : 'No concept set in this workspace.')
    return text(sets.slice(0, 100).map((s) =>
      `- ${s.name}${s.category ? ` (${s.category})` : ''} — concept_set_id: ${s.id} · ${s.expression?.items?.length ?? 0} item(s)`
      + `${s.resolvedConceptIds ? ` · ${s.resolvedConceptIds.length} resolved` : ''}`).join('\n')
      + (sets.length > 100 ? `\n… ${sets.length - 100} more: narrow with search.` : ''))
  }))

  server.registerTool('get_concept_set', {
    description: 'One concept set: its expression (concepts with descendant / mapped / excluded flags) and the '
      + 'resolved concept ids.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ concept_set_id: string }>({
      type: 'object', properties: { concept_set_id: { type: 'string' } }, required: ['concept_set_id'],
    }),
  }, guard(async ({ concept_set_id }) => text(describeConceptSet(await api.getConceptSet(concept_set_id)))))

  server.registerTool('list_concept_lists', {
    description: 'The project\'s concept lists: concepts picked by hand, which travel with the project.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const lists = await api.listConceptLists(project_uid)
    if (lists.length === 0) return text('No concept list in this project.')
    return text(lists.map((l) => `- ${loc(l.name)} — concept_list_id: ${l.id} · ${l.items.length} concept(s)`).join('\n'))
  }))

  server.registerTool('get_concept_list', {
    description: 'One concept list with its concepts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ concept_list_id: string }>({
      type: 'object', properties: { concept_list_id: { type: 'string' } }, required: ['concept_list_id'],
    }),
  }, guard(async ({ concept_list_id }) => {
    const l = await api.getConceptList(concept_list_id)
    const head = `Concept list "${loc(l.name)}" (concept_list_id ${l.id})${loc(l.description) ? `\n${loc(l.description)}` : ''}`
    return text(`${head}\n\n${l.items.length} concept(s):\n${describeItems(l.items)}`)
  }))

  server.registerTool('create_concept_list', {
    description: 'Create a concept list in a project, e.g. the concepts a study uses.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; name: string; description?: string; items: ItemInput[]; database_id?: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        items: ITEMS_SCHEMA,
        database_id: { type: 'string', description: 'The database the concepts were picked from (informational).' },
      },
      required: ['project_uid', 'name', 'items'],
    }),
  }, guard(async ({ project_uid, name, description, items, database_id }) => {
    const parsed = toListItems(items)
    if (parsed.errors.length) return failure(`Not created:\n- ${parsed.errors.join('\n- ')}`)
    const list = await api.createConceptList({
      id: randomUUID(), projectUid: project_uid, name: bilingual(name),
      description: description ? bilingual(description) : {}, items: parsed.items,
      ...(database_id ? { dataSourceId: database_id } : {}),
    })
    return text(`Created concept list "${name}" with ${list.items.length} concept(s) — concept_list_id: ${list.id}`)
  }))

  server.registerTool('update_concept_list', {
    description: 'Change a concept list: rename it, change its description, add concepts and/or remove them by id.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      concept_list_id: string; name?: string; description?: string; add?: ItemInput[]; remove_ids?: (number | string)[]
    }>({
      type: 'object',
      properties: {
        concept_list_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        add: ITEMS_SCHEMA,
        remove_ids: { type: 'array', items: { type: ['number', 'string'] } },
      },
      required: ['concept_list_id'],
    }),
  }, guard(async ({ concept_list_id, name, description, add, remove_ids }) => {
    const changes: Record<string, unknown> = {}
    if (name !== undefined) changes.name = bilingual(name)
    if (description !== undefined) changes.description = bilingual(description)
    if (add?.length || remove_ids?.length) {
      const parsed = toListItems(add ?? [])
      if (parsed.errors.length) return failure(`Not updated:\n- ${parsed.errors.join('\n- ')}`)
      const current = await api.getConceptList(concept_list_id)
      changes.items = editItems(current.items, parsed.items, (remove_ids ?? []).map(Number))
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    const list = await api.updateConceptList(concept_list_id, changes)
    return text(`Updated "${loc(list.name)}": ${list.items.length} concept(s).`)
  }))

  server.registerTool('delete_concept_list', {
    description: 'Delete a concept list. Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ concept_list_id: string }>({
      type: 'object', properties: { concept_list_id: { type: 'string' } }, required: ['concept_list_id'],
    }),
  }, guard(async ({ concept_list_id }) => {
    const list = await api.getConceptList(concept_list_id)
    await api.deleteConceptList(concept_list_id)
    return text(`Deleted concept list "${loc(list.name)}".`)
  }))
}
