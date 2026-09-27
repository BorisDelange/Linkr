/**
 * Concept mapping beyond suggesting: the mapping project's lifecycle, reviewing
 * and editing its mappings, and the workspace's source concept id registry
 * (custom OMOP ids, 2 billion and up, allocated per badge).
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type {
  ConceptMapping, MappingEquivalence, MappingProject, MappingProjectStatus, ProjectBadge, SourceConceptIdEntry,
  SourceConceptIdRange, User,
} from '@/types'
import { buildSourceConceptsAllQuery } from '@/lib/concept-mapping/mapping-queries'
import { isMappingLocked, readsFromFlatSource } from '@/lib/concept-mapping/mapping-status'
import { sourceConceptPairKey } from '@/lib/concept-mapping/source-concept-ids-io'
import { isOmopConceptTable } from '@/lib/concept-mapping/vocabulary-target'
import { clampNextId } from '@/features/warehouse/concept-mapping/source-id-range'
import { setLocalized } from '@/lib/localized'
import { userDisplayName, userToAuthorDetails } from '@/lib/user-identity'
import type { DataSource } from './api.js'
import { pointerRows } from './helpers.js'
import { MAX_WRITE, refreshStats } from './tools-mapping.js'
import { entityIdError } from './workspace.js'
import { EQUIVALENCES } from './mapping.js'
import {
  PROJECT_STATUSES, badgeLabelsOf, commentPatch, defaultEntityId, describeMapping, filterMappings,
  newMappingProjectPayload, planAssignment, pointerTo, rangeError, resolveBadges, reviewPatch, suggestRange, voteError,
  type Vote,
} from './mapping-extra.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, workspaceOf, type Server } from './shared.js'

const enc = encodeURIComponent
// The server caps a query at 10 000 rows; source concepts are read in pages of that size.
const PAGE = 10_000
const SAVE_CHUNK = 5_000

type Me = Pick<User, 'id' | 'username' | 'firstName' | 'lastName' | 'email' | 'orcid' | 'affiliation' | 'profession'>
type IdCount = { badgeLabel: string; assignedCount: number; ownCount: number; highestOwnId: number | null }

const x = {
  me: () => api.request<Me>('GET', '/auth/me'),
  createProject: (body: Record<string, unknown>) => api.request<MappingProject>('POST', '/mapping-projects', body),
  deleteProject: (id: string) => api.request<void>('DELETE', `/mapping-projects/${enc(id)}`),
  deleteProjectMappings: (id: string) => api.request<void>('DELETE', `/mapping-projects/${enc(id)}/mappings`),
  updateMapping: (id: string, changes: Record<string, unknown>) =>
    api.request<ConceptMapping>('PATCH', `/concept-mappings/${enc(id)}`, changes),
  deleteMapping: (id: string) => api.request<void>('DELETE', `/concept-mappings/${enc(id)}`),
  ranges: (workspaceId: string) =>
    api.request<SourceConceptIdRange[]>('GET', `/source-concept-id-ranges?workspaceId=${enc(workspaceId)}`),
  saveRange: (range: Omit<SourceConceptIdRange, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }) =>
    api.request<SourceConceptIdRange>('PUT', '/source-concept-id-ranges', range),
  counts: (workspaceId: string) => api.request<IdCount[]>('GET', `/source-concept-id-entries/counts?workspaceId=${enc(workspaceId)}`),
  entries: (workspaceId: string, badgeLabel: string) =>
    api.request<SourceConceptIdEntry[]>(
      'GET', `/source-concept-id-entries?workspaceId=${enc(workspaceId)}&badgeLabel=${enc(badgeLabel)}`,
    ),
  saveEntries: (entries: SourceConceptIdEntry[]) => api.request<void>('PUT', '/source-concept-id-entries/batch', { entries }),
}

async function identity() {
  const me = await x.me()
  return { name: userDisplayName({ ...me, firstName: me.firstName ?? '', lastName: me.lastName ?? '' }), details: userToAuthorDetails(me) }
}

const isVocabularyReference = (ds: DataSource) => !!(ds as DataSource & { isVocabularyReference?: boolean }).isVocabularyReference

/** The databases the app's pickers offer, or why `id` is not one of them. */
function checkSourceDatabase(dbs: DataSource[], workspaceId: string, id: string): string | null {
  const ds = dbs.find((d) => d.id === id)
  if (!ds) return `Database ${id} not found (list_projects / get_project_context list databases).`
  if (ds.workspaceId !== workspaceId) return `Database ${id} belongs to another workspace.`
  if (ds.sourceType !== 'database' || isVocabularyReference(ds)) return `"${loc(ds.name)}" is not a clinical database to map from.`
  if (!ds.schemaMapping?.concepts?.length) return `"${loc(ds.name)}" has no concept dictionary in its schema mapping.`
  return null
}

function checkVocabularyDatabase(dbs: DataSource[], workspaceId: string, id: string): string | null {
  const ds = dbs.find((d) => d.id === id)
  if (!ds) return `Database ${id} not found.`
  if (ds.workspaceId !== workspaceId) return `Database ${id} belongs to another workspace.`
  if (!ds.schemaMapping?.concepts?.some(isOmopConceptTable)) return `"${loc(ds.name)}" has no OMOP concept table (an ATHENA import).`
  return null
}

async function mappingsById(projectId: string, ids: string[]) {
  const all = await api.listMappings(projectId)
  const byId = new Map(all.map((m) => [m.id, m]))
  const missing = ids.filter((id) => !byId.has(id))
  return { byId, missing }
}

/** Every (vocabulary, code) of a project's source concepts, read a page at a time; null when the app would skip it. */
async function sourcePairs(project: MappingProject): Promise<[string, string][] | null> {
  const pairs: [string, string][] = []
  const pages = async (run: (limit: number, offset: number) => Promise<Record<string, unknown>[]>, push: (r: Record<string, unknown>) => void) => {
    for (let offset = 0; ; offset += PAGE) {
      const rows = await run(PAGE, offset)
      rows.forEach(push)
      if (rows.length < PAGE) break
    }
  }
  if (readsFromFlatSource(project)) {
    const fsd = project.fileSourceData
    // A file carrying real OMOP concept ids needs none of ours; a sourceless project has nothing.
    if (!fsd || (project.sourceType === 'file' && fsd.columnMapping?.conceptIdColumn)) return null
    const hasVocab = !!fsd.columnMapping?.terminologyColumn
    const fallback = loc(project.name)
    await pages(
      (limit, offset) => api.queryMappingSource(project.id,
        `SELECT DISTINCT CAST(concept_code AS VARCHAR) AS code${hasVocab ? ', CAST(vocabulary_id AS VARCHAR) AS vocab' : ''} `
        + `FROM source_concepts ORDER BY 1${hasVocab ? ', 2' : ''} LIMIT ${limit} OFFSET ${offset}`),
      (r) => pairs.push([String(r.vocab ?? fallback), String(r.code ?? '')]),
    )
    return pairs
  }
  if (!project.dataSourceId) throw new Error('no source database')
  const ds = await api.getDataSource(project.dataSourceId)
  const inner = ds.schemaMapping ? buildSourceConceptsAllQuery(ds.schemaMapping, {}) : ''
  if (!inner) throw new Error('its database has no concept dictionary')
  await pages(
    (limit, offset) => api.query(ds.id,
      `SELECT DISTINCT CAST(concept_code AS VARCHAR) AS code, CAST(concept_id AS VARCHAR) AS cid, `
      + `CAST(vocabulary_id AS VARCHAR) AS vocab FROM (${inner}) AS s ORDER BY 1, 2, 3 LIMIT ${limit} OFFSET ${offset}`),
    (r) => pairs.push([String(r.vocab ?? ds.id), String(r.code || r.cid || '')]),
  )
  return pairs
}

const statusSchema = { type: 'string', enum: PROJECT_STATUSES, description: 'in_progress (default), on_hold or completed.' }

export function registerMappingExtraTools(server: Server): void {
  server.registerTool('create_mapping_project', {
    description: 'Create a concept-mapping project (a workspace-level project where local terminology codes are mapped to '
      + 'OMOP standard concepts). Its source concepts come from a clinical database\'s concept dictionaries (database_id); '
      + 'without one the project starts empty and the user imports a file into it in Linkr (file upload is not available '
      + 'here). vocabulary_database_id is an OMOP vocabulary database (ATHENA import) to search targets in.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      workspace_id?: string; project_uid?: string; name: string; description?: string; entity_id?: string
      status?: MappingProjectStatus; badges?: string[]; version?: string; database_id?: string; vocabulary_database_id?: string
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project_uid: { type: 'string', description: 'Or a project: its workspace is used.' },
        name: { type: 'string' },
        description: { type: 'string' },
        entity_id: { type: 'string', description: 'Readable identifier (a-z, 0-9, hyphens), fixed for good. Default: from the name.' },
        status: statusSchema,
        badges: { type: 'array', items: { type: 'string' }, description: 'Badge labels, e.g. the hospital ("Rennes"); source concept id ranges are allocated per badge.' },
        version: { type: 'string', description: 'Semver, default 0.1.0.' },
        database_id: { type: 'string', description: 'Clinical database of the same workspace whose concept dictionaries are the source concepts.' },
        vocabulary_database_id: { type: 'string', description: 'OMOP vocabulary database of the same workspace. Default: targets are searched in the source database.' },
      },
      required: ['name'],
    }),
  }, guard(async (args) => {
    if (!args.name?.trim()) return failure('name is required.')
    const workspaceId = await workspaceOf(args)
    const status = args.status ?? 'in_progress'
    if (!PROJECT_STATUSES.includes(status)) return failure(`status must be one of ${PROJECT_STATUSES.join(', ')}.`)
    const siblings = await api.listMappingProjects(workspaceId)
    const taken = siblings.map((p) => p.entityId).filter((id): id is string => !!id)
    const entityId = args.entity_id?.trim() || defaultEntityId(args.name, taken)
    const idError = entityIdError(entityId, taken, 'mapping project of this workspace')
    if (idError) return failure(`Invalid entity_id "${entityId}": ${idError}.`)
    const dbs = (args.database_id || args.vocabulary_database_id) ? await api.listDataSources() : []
    const dbError = (args.database_id && checkSourceDatabase(dbs, workspaceId, args.database_id))
      || (args.vocabulary_database_id && checkVocabularyDatabase(dbs, workspaceId, args.vocabulary_database_id))
    if (dbError) return failure(dbError)
    const badges = resolveBadges(args.badges ?? [], siblings.flatMap((p) => p.badges ?? []), randomUUID)
    const created = await x.createProject(newMappingProjectPayload({
      id: randomUUID(), lineageId: randomUUID(), workspaceId, entityId, name: args.name, description: args.description,
      status, badges, version: args.version?.trim() || '0.1.0', databaseId: args.database_id,
      vocabularyDatabaseId: args.vocabulary_database_id, databases: pointerRows(dbs), now: new Date().toISOString(),
    }))
    const source = args.database_id ? `source: database ${args.database_id}` : 'no source yet — the user imports a file in Linkr'
    return text(`Created mapping project "${loc(created.name)}" — mapping_project_id: ${created.id} (entity_id ${entityId}, `
      + `workspace_id ${workspaceId}); ${source}${args.vocabulary_database_id ? `; vocabulary database ${args.vocabulary_database_id}` : ''}.`)
  }))

  server.registerTool('update_mapping_project', {
    description: 'Edit a mapping project\'s metadata: name, description, status, badges (replaces the list), version, '
      + 'source database (only for a project that reads a database, not a file) and vocabulary database (null to remove).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string; name?: string; description?: string; status?: MappingProjectStatus; badges?: string[]
      version?: string; database_id?: string; vocabulary_database_id?: string | null
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        name: { type: 'string', description: 'English name; other languages are kept.' },
        description: { type: 'string' },
        status: statusSchema,
        badges: { type: 'array', items: { type: 'string' } },
        version: { type: 'string' },
        database_id: { type: 'string' },
        vocabulary_database_id: { type: ['string', 'null'] },
      },
      required: ['mapping_project_id'],
    }),
  }, guard(async (args) => {
    const p = await api.getMappingProject(args.mapping_project_id)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) {
      if (!args.name.trim()) return failure('name cannot be empty.')
      changes.name = setLocalized(p.name, 'en', args.name.trim())
    }
    if (args.description !== undefined) changes.description = setLocalized(p.description, 'en', args.description.trim())
    if (args.status !== undefined) {
      if (!PROJECT_STATUSES.includes(args.status)) return failure(`status must be one of ${PROJECT_STATUSES.join(', ')}.`)
      changes.status = args.status
    }
    if (args.version !== undefined) changes.version = args.version.trim() || '0.1.0'
    if (args.badges !== undefined) {
      const current = new Map((p.badges ?? []).map((b) => [loc(b.label).trim().toLowerCase(), b]))
      const siblings = (await api.listMappingProjects(p.workspaceId)).flatMap((q) => q.badges ?? [])
      const fresh = resolveBadges(args.badges, siblings, randomUUID)
      changes.badges = fresh.map((b): ProjectBadge => current.get(loc(b.label).trim().toLowerCase()) ?? b)
    }
    const needDbs = args.database_id !== undefined || (args.vocabulary_database_id ?? null) !== null
    const dbs = needDbs ? await api.listDataSources() : []
    if (args.database_id !== undefined) {
      if (readsFromFlatSource(p) && p.fileSourceData) {
        return failure('This project reads its source concepts from a file (or an extraction); its source cannot be switched here.')
      }
      const error = checkSourceDatabase(dbs, p.workspaceId, args.database_id)
      if (error) return failure(error)
      changes.sourceType = 'database'
      changes.dataSourceId = args.database_id
      changes.dataSourceRef = pointerTo(pointerRows(dbs), args.database_id) ?? null
    }
    if (args.vocabulary_database_id !== undefined) {
      if (args.vocabulary_database_id === null) {
        changes.vocabularyDataSourceId = null
        changes.vocabularyDataSourceRef = null
      } else {
        const error = checkVocabularyDatabase(dbs, p.workspaceId, args.vocabulary_database_id)
        if (error) return failure(error)
        changes.vocabularyDataSourceId = args.vocabulary_database_id
        changes.vocabularyDataSourceRef = pointerTo(pointerRows(dbs), args.vocabulary_database_id) ?? null
      }
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    await api.updateMappingProject(p.id, changes)
    return text(`Updated mapping project "${loc((changes.name as Record<string, string>) ?? p.name)}": ${Object.keys(changes).join(', ')}.`)
  }))

  server.registerTool('delete_mapping_project', {
    description: 'Delete a mapping project with all its mappings, reviews and comments, its source file and its suggestions. '
      + 'Cannot be undone. Ask the user first, naming the project and its mapping count.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string }>({
      type: 'object', properties: { mapping_project_id: { type: 'string' } }, required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id }) => {
    const p = await api.getMappingProject(mapping_project_id)
    const count = (await api.listMappings(p.id)).length
    await x.deleteProjectMappings(p.id)
    await x.deleteProject(p.id)
    return text(`Deleted mapping project "${loc(p.name)}" and its ${count} mapping(s).`)
  }))

  server.registerTool('list_mappings', {
    description: 'The mappings of a mapping project (source concept → OMOP target), with their review status, votes and '
      + 'comment count, and their mapping_id for review_mappings / update_mapping / delete_mappings. "locked" means '
      + 'someone else has reviewed or commented it: its equivalence can no longer be edited.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string
      status?: 'unchecked' | 'approved' | 'rejected' | 'flagged' | 'ignored' | 'disputed' | 'all'
      search?: string; concept_codes?: string[]; target_concept_id?: number | string; equivalence?: string
      mapped_by?: string; category?: string; reviewed_by_me?: boolean; limit?: number; offset?: number
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        status: {
          type: 'string', enum: ['unchecked', 'approved', 'rejected', 'flagged', 'ignored', 'disputed', 'all'],
          description: 'Effective status (from the votes; disputed = reviewers disagree). Default all.',
        },
        search: { type: 'string', description: 'Words in the source or target name or code.' },
        concept_codes: { type: 'array', items: { type: 'string' }, description: 'Source codes (or vocabulary/code).' },
        target_concept_id: { type: ['number', 'string'] },
        equivalence: { type: 'string', enum: EQUIVALENCES },
        mapped_by: { type: 'string', description: 'Author name (a person or a model).' },
        category: { type: 'string', description: 'Source category.' },
        reviewed_by_me: { type: 'boolean', description: 'true: only those the user voted on; false: only those they have not.' },
        limit: { type: 'number', description: 'Default 50, max 200.' },
        offset: { type: 'number' },
      },
      required: ['mapping_project_id'],
    }),
  }, guard(async (args) => {
    const p = await api.getMappingProject(args.mapping_project_id)
    const me = args.reviewed_by_me != null ? (await identity()).name : undefined
    const all = await api.listMappings(p.id)
    const target = args.target_concept_id !== undefined ? Number(args.target_concept_id) : undefined
    const found = filterMappings(all, {
      status: args.status, search: args.search, conceptCodes: args.concept_codes, targetConceptId: target,
      equivalence: args.equivalence, mappedBy: args.mapped_by, category: args.category, reviewedByMe: args.reviewed_by_me, me,
    }).sort((a, b) => a.sourceConceptCode.localeCompare(b.sourceConceptCode, undefined, { numeric: true }))
    if (found.length === 0) return text(`No mapping matches (${all.length} in the project).`)
    const size = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 200)
    const offset = Math.max(0, Math.floor(args.offset ?? 0))
    const page = found.slice(offset, offset + size)
    const end = offset + page.length
    return text(`${found.length} mapping(s) match (of ${all.length}); showing ${offset + 1}–${end}.`
      + `${end < found.length ? ` Next page: offset ${end}.` : ''}\n\n${page.map(describeMapping).join('\n')}`)
  }))

  server.registerTool('review_mappings', {
    description: 'Vote on mappings as the user, as the app\'s review buttons do: approved, rejected or flagged, with an '
      + 'optional comment; "clear" withdraws the user\'s vote. One vote per reviewer; the effective status follows the '
      + 'votes (disagreeing votes make it "disputed"). The author of a mapping cannot approve or reject it. Only on the '
      + 'user\'s explicit instruction, mapping by mapping or for a set they named.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; mapping_ids: string[]; vote: Vote; comment?: string }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        mapping_ids: { type: 'array', items: { type: 'string' }, description: `From list_mappings, up to ${MAX_WRITE}.` },
        vote: { type: 'string', enum: ['approved', 'rejected', 'flagged', 'clear'] },
        comment: { type: 'string', description: 'The reason, stored with the vote.' },
      },
      required: ['mapping_project_id', 'mapping_ids', 'vote'],
    }),
  }, guard(async ({ mapping_project_id, mapping_ids, vote, comment }) => {
    if (!mapping_ids?.length) return failure('No mapping_ids given.')
    if (mapping_ids.length > MAX_WRITE) return failure(`At most ${MAX_WRITE} mappings per call.`)
    if (!['approved', 'rejected', 'flagged', 'clear'].includes(vote)) return failure('vote must be approved, rejected, flagged or clear.')
    const p = await api.getMappingProject(mapping_project_id)
    const { byId, missing } = await mappingsById(p.id, mapping_ids)
    if (missing.length) return failure(`Not in this project (see list_mappings): ${missing.join(', ')}.`)
    const me = await identity()
    const errors = mapping_ids.map((id) => {
      const e = voteError(byId.get(id)!, me.name, vote)
      return e ? `${id}: ${e}` : null
    }).filter((e): e is string => !!e)
    if (errors.length) return failure(`Nothing written:\n- ${errors.join('\n- ')}`)
    const now = new Date().toISOString()
    for (const id of new Set(mapping_ids)) {
      await x.updateMapping(id, reviewPatch(byId.get(id)!, me.name, me.details, vote, comment, now, randomUUID))
    }
    await refreshStats(p)
    return text(vote === 'clear'
      ? `Withdrew ${me.name}'s vote on ${new Set(mapping_ids).size} mapping(s).`
      : `Recorded ${me.name}'s vote "${vote}" on ${new Set(mapping_ids).size} mapping(s).`)
  }))

  server.registerTool('update_mapping', {
    description: 'Edit one mapping: change its equivalence (refused once someone else has reviewed or commented it — '
      + 'the app locks it) and/or add a comment signed by the user. The target concept cannot be changed: delete the '
      + 'mapping and create another (create_mappings).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; mapping_id: string; equivalence?: MappingEquivalence; comment?: string }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        mapping_id: { type: 'string' },
        equivalence: { type: 'string', enum: EQUIVALENCES },
        comment: { type: 'string', description: 'A comment to append to the mapping\'s thread.' },
      },
      required: ['mapping_project_id', 'mapping_id'],
    }),
  }, guard(async ({ mapping_project_id, mapping_id, equivalence, comment }) => {
    if (!equivalence && !comment?.trim()) return failure('Give an equivalence or a comment.')
    if (equivalence && !EQUIVALENCES.includes(equivalence)) return failure(`equivalence must be one of ${EQUIVALENCES.join(', ')}.`)
    const p = await api.getMappingProject(mapping_project_id)
    const { byId, missing } = await mappingsById(p.id, [mapping_id])
    if (missing.length) return failure(`Mapping ${mapping_id} is not in this project (see list_mappings).`)
    const m = byId.get(mapping_id)!
    if (equivalence && equivalence !== m.equivalence && isMappingLocked(m)) {
      return failure('This mapping is locked: someone other than its author has reviewed or commented it. Leave a comment instead.')
    }
    const changes: Record<string, unknown> = {}
    if (equivalence && equivalence !== m.equivalence) changes.equivalence = equivalence
    if (comment?.trim()) {
      const me = await identity()
      Object.assign(changes, commentPatch(m, me.name, me.details, comment, new Date().toISOString(), randomUUID()))
    }
    if (Object.keys(changes).length === 0) return text('Nothing changed: the mapping already has this equivalence.')
    await x.updateMapping(m.id, changes)
    return text(`Updated mapping ${m.id} (${m.sourceConceptCode} → ${m.targetConceptId}): ${Object.keys(changes).join(', ')}.`)
  }))

  server.registerTool('delete_mappings', {
    description: 'Delete mappings of a mapping project (their votes and comments go with them). Mappings someone else '
      + 'reviewed or commented are refused unless include_locked is true. Cannot be undone. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; mapping_ids: string[]; include_locked?: boolean }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        mapping_ids: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_WRITE}.` },
        include_locked: { type: 'boolean', description: 'Also delete reviewed / commented ones (the user said so).' },
      },
      required: ['mapping_project_id', 'mapping_ids'],
    }),
  }, guard(async ({ mapping_project_id, mapping_ids, include_locked }) => {
    if (!mapping_ids?.length) return failure('No mapping_ids given.')
    if (mapping_ids.length > MAX_WRITE) return failure(`At most ${MAX_WRITE} mappings per call.`)
    const p = await api.getMappingProject(mapping_project_id)
    const { byId, missing } = await mappingsById(p.id, mapping_ids)
    if (missing.length) return failure(`Not in this project (see list_mappings): ${missing.join(', ')}.`)
    const locked = mapping_ids.filter((id) => isMappingLocked(byId.get(id)!))
    if (locked.length && !include_locked) {
      return failure(`Nothing deleted: reviewed or commented by someone else: ${locked.join(', ')}. `
        + 'Confirm with the user, then pass include_locked: true.')
    }
    const ids = [...new Set(mapping_ids)]
    for (const id of ids) await x.deleteMapping(id)
    await refreshStats(p)
    return text(`Deleted ${ids.length} mapping(s).`)
  }))

  server.registerTool('list_source_concept_id_ranges', {
    description: 'The workspace\'s source concept id registry: OMOP reserves concept ids from 2 000 000 000 for local '
      + 'concepts, and Linkr gives each badge (e.g. a hospital) its own range, so a source concept keeps one stable id '
      + 'per site. Lists each range, its use, and the badges that have none yet.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string }>({
      type: 'object', properties: { workspace_id: { type: 'string' }, project_uid: { type: 'string' } },
    }),
  }, guard(async (args) => {
    const workspaceId = await workspaceOf(args)
    const [ranges, counts, projects] = await Promise.all([x.ranges(workspaceId), x.counts(workspaceId), api.listMappingProjects(workspaceId)])
    const byBadge = new Map(counts.map((c) => [c.badgeLabel, c]))
    const lines = ranges.sort((a, b) => a.rangeStart - b.rangeStart).map((r) => {
      const c = byBadge.get(r.badgeLabel)
      const capacity = r.rangeEnd - r.rangeStart + 1
      const users = projects.filter((p) => badgeLabelsOf([p]).includes(r.badgeLabel)).map((p) => loc(p.name))
      return `- ${r.badgeLabel}: ${r.rangeStart}–${r.rangeEnd} (${capacity} ids) · ${c?.assignedCount ?? 0} assigned`
        + ` (${c?.ownCount ?? 0} from this range) · next ${r.nextId}`
        + `${users.length ? ` · projects: ${users.join(', ')}` : ' · no project carries this badge'}`
    })
    const without = badgeLabelsOf(projects).filter((b) => !ranges.some((r) => r.badgeLabel === b))
    if (!lines.length && !without.length) return text('No range, and no mapping project carries a badge yet.')
    return text([...(lines.length ? lines : ['No range yet.']),
      ...(without.length ? ['', `Badges without a range: ${without.join(', ')}.`] : [])].join('\n'))
  }))

  server.registerTool('set_source_concept_id_range', {
    description: 'Give a badge its source concept id range, or move an existing range\'s bounds. Without bounds, a new '
      + 'range takes the next million ids after the highest one, as the app does. Ranges stay within '
      + '2 000 000 000–2 147 483 647 and never overlap.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string; badge: string; range_start?: number; range_end?: number }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project_uid: { type: 'string' },
        badge: { type: 'string', description: 'The badge\'s English label, as a mapping project carries it.' },
        range_start: { type: 'number' },
        range_end: { type: 'number' },
      },
      required: ['badge'],
    }),
  }, guard(async (args) => {
    const workspaceId = await workspaceOf(args)
    const [ranges, counts, projects] = await Promise.all([x.ranges(workspaceId), x.counts(workspaceId), api.listMappingProjects(workspaceId)])
    const badge = args.badge.trim()
    const existing = ranges.find((r) => r.badgeLabel === badge)
    if (!existing && !badgeLabelsOf(projects).includes(badge)) {
      return failure(`No mapping project carries the badge "${badge}". Badges: ${badgeLabelsOf(projects).join(', ') || 'none'}.`)
    }
    const suggested = suggestRange(ranges)
    const start = args.range_start ?? existing?.rangeStart ?? suggested?.start
    const end = args.range_end ?? existing?.rangeEnd ?? suggested?.end
    if (start === undefined || end === undefined) return failure('The local concept band is full: give range_start and range_end.')
    const error = rangeError(ranges, badge, start, end)
    if (error) return failure(error)
    const now = new Date().toISOString()
    const highest = counts.find((c) => c.badgeLabel === badge)?.highestOwnId ?? null
    await x.saveRange({
      ...(existing ?? {}),
      workspaceId, badgeLabel: badge, rangeStart: start, rangeEnd: end,
      // Moving the bounds moves the cursor with them, or ids would be handed out outside the new range.
      nextId: existing ? clampNextId(existing.nextId, start, end, highest) : start,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    return text(`${existing ? 'Moved' : 'Created'} the range of "${badge}": ${start}–${end}. `
      + 'assign_source_concept_ids hands out its ids.')
  }))

  server.registerTool('assign_source_concept_ids', {
    description: 'The app\'s Assign button for one badge: gives a custom OMOP concept id (from the badge\'s range) to every '
      + 'source concept of the badge\'s mapping projects that has none yet. Ids already given never change. Files '
      + 'whose rows carry real OMOP concept ids are skipped.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string; badge: string }>({
      type: 'object',
      properties: { workspace_id: { type: 'string' }, project_uid: { type: 'string' }, badge: { type: 'string' } },
      required: ['badge'],
    }),
  }, guard(async (args) => {
    const workspaceId = await workspaceOf(args)
    const badge = args.badge.trim()
    const [ranges, counts, projects] = await Promise.all([x.ranges(workspaceId), x.counts(workspaceId), api.listMappingProjects(workspaceId)])
    const range = ranges.find((r) => r.badgeLabel === badge)
    if (!range) return failure(`The badge "${badge}" has no range: set_source_concept_id_range first.`)
    const withBadge = projects.filter((p) => badgeLabelsOf([p]).includes(badge))
    if (withBadge.length === 0) return text(`No mapping project carries the badge "${badge}": nothing to assign.`)
    const pairs: [string, string][] = []
    const unreadable: string[] = []
    const skipped: string[] = []
    for (const p of withBadge) {
      try {
        const got = await sourcePairs(p)
        if (got) pairs.push(...got)
        else skipped.push(loc(p.name))
      } catch (e) {
        unreadable.push(`${loc(p.name)} (${(e as Error).message})`)
      }
    }
    const existing = await x.entries(workspaceId, badge)
    const plan = planAssignment({
      pairs,
      existingKeys: new Set(existing.map((e) => sourceConceptPairKey(e.vocabularyId, e.conceptCode))),
      range,
      highestOwnId: counts.find((c) => c.badgeLabel === badge)?.highestOwnId ?? null,
      now: new Date().toISOString(),
    })
    // The cursor is saved after every chunk: a failed chunk then burns ids rather than handing them out twice.
    const saveCursor = (nextId: number, written: number) => x.saveRange({
      ...range, nextId, totalConcepts: existing.length + written, updatedAt: new Date().toISOString(),
    })
    if (plan.entries.length === 0) await saveCursor(plan.nextId, 0)
    for (let i = 0; i < plan.entries.length; i += SAVE_CHUNK) {
      const chunk = plan.entries.slice(i, i + SAVE_CHUNK)
      await x.saveEntries(chunk)
      await saveCursor(chunk[chunk.length - 1].sourceConceptId + 1, i + chunk.length)
    }
    const lines = [`Badge "${badge}": ${plan.total} source concept(s) across ${withBadge.length} project(s); `
      + `${plan.entries.length} newly assigned${plan.entries.length ? ` (${plan.entries[0].sourceConceptId}–${plan.entries[plan.entries.length - 1].sourceConceptId})` : ''}, `
      + `${existing.length} already had one.`]
    if (plan.exhausted) lines.push(`The range is exhausted (ends at ${range.rangeEnd}): some concepts got no id. Widen it with set_source_concept_id_range.`)
    if (skipped.length) lines.push(`Skipped (a file with real OMOP ids, or no source yet): ${skipped.join(', ')}.`)
    if (unreadable.length) lines.push(`Could not read, nothing assigned for: ${unreadable.join('; ')}.`)
    return text(lines.join('\n'))
  }))

  server.registerTool('get_source_concept_ids', {
    description: 'The custom OMOP concept ids assigned to source concepts under a badge: for given codes, or a page of them.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      workspace_id?: string; project_uid?: string; badge: string; concept_codes?: string[]; limit?: number; offset?: number
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        project_uid: { type: 'string' },
        badge: { type: 'string' },
        concept_codes: { type: 'array', items: { type: 'string' }, description: 'Source codes, or vocabulary/code.' },
        limit: { type: 'number', description: 'Default 50, max 500.' },
        offset: { type: 'number' },
      },
      required: ['badge'],
    }),
  }, guard(async (args) => {
    const workspaceId = await workspaceOf(args)
    const all = await x.entries(workspaceId, args.badge.trim())
    if (all.length === 0) return text(`No id assigned under the badge "${args.badge}".`)
    const codes = args.concept_codes?.length ? new Set(args.concept_codes) : null
    const found = (codes ? all.filter((e) => codes.has(e.conceptCode) || codes.has(`${e.vocabularyId}/${e.conceptCode}`)) : all)
      .sort((a, b) => a.sourceConceptId - b.sourceConceptId)
    const size = Math.min(Math.max(1, Math.floor(args.limit ?? 50)), 500)
    const offset = Math.max(0, Math.floor(args.offset ?? 0))
    const page = found.slice(offset, offset + size)
    const end = offset + page.length
    const header = `${found.length} of ${all.length} assigned id(s)${codes ? ' match' : ''}; showing ${found.length ? offset + 1 : 0}–${end}.`
      + `${end < found.length ? ` Next page: offset ${end}.` : ''}`
    return text(`${header}\n${page.map((e) => `- ${e.vocabularyId}/${e.conceptCode} → ${e.sourceConceptId}`).join('\n')}`)
  }))
}
