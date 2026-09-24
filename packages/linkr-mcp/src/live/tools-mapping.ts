/**
 * Concept mapping: read a mapping project's source concepts and the OMOP
 * vocabulary, then leave AI suggestions (reviewed in the app) or, on the user's
 * say-so, mappings. The procedure an agent follows lives in the
 * `concept-mapping` skill (packages/linkr-mcp/skills/).
 */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type { ConceptMapping, MappingEquivalence, MappingProject, SchemaMapping } from '@/types'
import {
  buildConceptAncestorsQuery, buildConceptDescendantCountQuery, buildConceptDescendantsQuery,
  buildConceptRelationsQuery, buildConceptSynonymsQuery,
} from '@/lib/concept-mapping/concept-detail-queries'
import {
  buildFileSourceConceptsCountQuery, buildFileSourceConceptsQuery, buildSourceConceptsRelation, buildStandardConceptSearchQuery,
  type SourceConceptFilters,
} from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus, getTotalSourceConcepts, readsFromFlatSource } from '@/lib/concept-mapping/mapping-status'
import { isOmopConceptTable, resolveVocabularyTarget } from '@/lib/concept-mapping/vocabulary-target'
import {
  checkJudgement, checkTarget, conceptsByIdSql, describeConcept, describeInfo, describeSourceRow, groupSuggestions,
  indexKeyToSourceKey, mappingPayload, methodForModel, sourceByCodesSql, sourceKeyOf, sourceKeysInSql, sourceRefCandidates,
  synonymSearchSql,
  type SourceRow, type SuggestionInput, type VocabConcept,
} from './mapping.js'
import type { DataSource } from './api.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'

const MAX_WRITE = 200

interface Vocabulary { databaseId: string; mapping: SchemaMapping; table: string }

async function vocabularyOf(project: MappingProject): Promise<Vocabulary> {
  const ids = [project.vocabularyDataSourceId, project.dataSourceId].filter((id): id is string => !!id)
  const sources = await Promise.all(ids.map((id) => api.getDataSource(id).catch(() => null)))
  const [vocabDs, sourceDs] = project.vocabularyDataSourceId ? [sources[0], sources[1]] : [null, sources[0]]
  const target = resolveVocabularyTarget(project, sourceDs, sources.filter((d): d is DataSource => !!d))
  if (!target || !isOmopConceptTable(target.dictionary)) {
    const ds = vocabDs ?? sourceDs
    throw new Error(`${project.vocabularyDataSourceId ? 'The vocabulary database' : 'This project has no vocabulary database, and its source database'} `
      + `${ds ? `"${loc(ds.name)}" ` : ''}has no OMOP concept table. Ask the user to pick an OMOP vocabulary database `
      + '(e.g. an ATHENA import) in the mapping project\'s settings in Linkr.')
  }
  return { databaseId: target.dsId, mapping: target.mapping, table: target.conceptTable }
}

/**
 * Where a project's source concepts are read. Every tool queries a relation
 * named `source_concepts`: the server's view over the flat source (an imported
 * file, or a database project once extracted), or — for a database project not
 * extracted yet — the database's dictionaries unioned into the same shape, with
 * no counts and no metadata.
 */
interface Source {
  query: (sql: string) => Promise<Record<string, unknown>[]>
  extracted: boolean
  columns: { vocabulary: boolean; category: boolean; subcategory: boolean; records: boolean; patients: boolean; info: boolean }
}

async function sourceOf(project: MappingProject): Promise<Source> {
  if (readsFromFlatSource(project)) {
    const cm = project.fileSourceData?.columnMapping ?? {}
    return {
      query: (sql) => api.queryMappingSource(project.id, sql),
      extracted: true,
      columns: {
        vocabulary: !!cm.terminologyColumn, category: !!cm.categoryColumn, subcategory: !!cm.subcategoryColumn,
        records: !!cm.recordCountColumn, patients: !!cm.patientCountColumn, info: !!cm.infoJsonColumn,
      },
    }
  }
  if (!project.dataSourceId) throw new Error('This mapping project has no source database.')
  const ds = await api.getDataSource(project.dataSourceId)
  const dicts = ds.schemaMapping?.conceptTables ?? []
  const relation = ds.schemaMapping ? buildSourceConceptsRelation(ds.schemaMapping) : ''
  if (!relation) throw new Error(`The source database "${loc(ds.name)}" has no concept dictionary in its schema mapping.`)
  return {
    query: (sql) => api.query(ds.id, `WITH source_concepts AS (${relation}) ${sql}`),
    extracted: false,
    columns: {
      vocabulary: true, category: dicts.some((d) => d.categoryColumn), subcategory: dicts.some((d) => d.subcategoryColumn),
      records: false, patients: false, info: false,
    },
  }
}

const NOT_EXTRACTED_NOTE = 'This database project has not been extracted: no record counts and no metadata (units, '
  + 'distributions). The extraction (mapping project → Source concepts tab in Linkr) would add them.'

async function conceptsById(v: Vocabulary, ids: number[]): Promise<Map<number, VocabConcept>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
  if (unique.length === 0) return new Map()
  const rows = await api.query(v.databaseId, conceptsByIdSql(v.table, unique)) as unknown as VocabConcept[]
  return new Map(rows.map((r) => [Number(r.concept_id), { ...r, concept_id: Number(r.concept_id) }]))
}

async function sourcesByCode(source: Source, codes: { code: string; vocabularyId?: string | null }[]) {
  const hasVocabulary = source.columns.vocabulary
  const refs = codes.flatMap((c) => sourceRefCandidates(c.code, c.vocabularyId))
  const rows = refs.length ? await source.query(sourceByCodesSql(refs, hasVocabulary)) as SourceRow[] : []
  const byKey = new Map<string, SourceRow>()
  const byCode = new Map<string, SourceRow[]>()
  for (const r of rows) {
    byKey.set(sourceKeyOf(r.vocabulary_id, r.concept_code), r)
    byCode.set(String(r.concept_code), [...(byCode.get(String(r.concept_code)) ?? []), r])
  }
  /** The row for a code, or why there is none (unknown, or ambiguous without a vocabulary). */
  const resolve = (code: string, vocabularyId?: string | null): SourceRow | string => {
    if (hasVocabulary && vocabularyId) return byKey.get(sourceKeyOf(vocabularyId, code)) ?? `no source concept ${vocabularyId}/${code}`
    const matches = byCode.get(code) ?? []
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) return `no source concept with code ${code}`
    return `code ${code} exists in several vocabularies (${matches.map((m) => String(m.vocabulary_id)).join(', ')}): give vocabulary_id`
  }
  return (code: string, vocabularyId?: string | null): SourceRow | string => {
    const [asGiven, ...others] = sourceRefCandidates(code, vocabularyId).map((r) => resolve(r.code, r.vocabularyId))
    return typeof asGiven !== 'string' ? asGiven : others.find((r) => typeof r !== 'string') ?? asGiven
  }
}

/** The stats the project list shows, refreshed the way the app does after a write. */
async function refreshStats(project: MappingProject) {
  const counts = await api.mappingStats(project.id)
  const total = getTotalSourceConcepts(project)
  await api.updateMappingProject(project.id, {
    stats: { ...counts, totalSourceConcepts: total, unmappedCount: Math.max(0, total - counts.mappedCount) },
  })
}

/** The relationships that decide a mapping first; panels and the like last. */
const RELATION_ORDER = ['Maps to', 'Maps to value', 'Mapped from', 'Concept replaced by', 'Is a', 'Subsumes', 'Has component', 'Has scale type']
function sortRelations(rows: Record<string, unknown>[]) {
  const rank = (r: Record<string, unknown>) => {
    const i = RELATION_ORDER.indexOf(String(r.relationship_id))
    return i < 0 ? RELATION_ORDER.length : i
  }
  return [...rows].sort((a, b) => rank(a) - rank(b))
}

const statusLabel = (mappings: ConceptMapping[]) =>
  mappings.map((m) => `${effectiveMappingStatus(m)}${m.targetConceptId ? ` → ${m.targetConceptId}` : ''}`).join(', ')

export function registerMappingTools(server: Server) {
  server.registerTool('list_mapping_projects', {
    description: 'Concept-mapping projects (local terminology → OMOP standard concepts) the user can read, '
      + 'with their progress. Start here to map concepts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string }>({
      type: 'object', properties: { workspace_id: { type: 'string', description: 'Only this workspace\'s projects.' } },
    }),
  }, guard(async ({ workspace_id }) => {
    const projects = await api.listMappingProjects(workspace_id)
    if (projects.length === 0) return text('No mapping project.')
    return text(projects.map((p) => {
      const s = p.stats
      const progress = s ? `${s.mappedCount}/${s.totalSourceConcepts} mapped, ${s.approvedCount} approved` : 'no stats yet'
      return `- ${loc(p.name)} — mapping_project_id: ${p.id} · ${progress} · workspace_id: ${p.workspaceId}`
    }).join('\n'))
  }))

  server.registerTool('get_mapping_project', {
    description: 'A mapping project: its source, vocabulary database, live progress, precomputed suggestions, and '
      + 'the source categories with their sizes.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ mapping_project_id: string }>({
      type: 'object', properties: { mapping_project_id: { type: 'string' } }, required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id }) => {
    const p = await api.getMappingProject(mapping_project_id)
    const lines = [`Mapping project "${loc(p.name)}" (mapping_project_id ${p.id}, workspace_id ${p.workspaceId})`]
    if (loc(p.description)) lines.push(loc(p.description))
    const counts = await api.mappingStats(p.id)
    const total = getTotalSourceConcepts(p)
    lines.push('', `Progress: ${counts.mappedCount} of ${total || '?'} source concepts mapped — ${counts.approvedCount} approved, `
      + `${counts.flaggedCount} flagged, ${counts.ignoredCount} ignored.`)
    try {
      const v = await vocabularyOf(p)
      lines.push(`Vocabulary database: ${loc((await api.getDataSource(v.databaseId)).name)} (database_id ${v.databaseId}, table ${v.table}).`)
    } catch (e) {
      lines.push(`Vocabulary database: unusable — ${(e as Error).message}`)
    }
    const index = await api.scoresIndex(p.id).catch(() => null)
    if (index) {
      const perCategory = Object.entries(index.categorySourceKeys).filter(([, keys]) => keys.length)
        .map(([cat, keys]) => `${cat} ${keys.length}`).join(', ')
      lines.push(`Suggestions file: ${index.rowCount} rows for ${index.sourceKeys.length} source concepts; methods ${index.methods.join(', ')}`
        + `${perCategory ? `; sources per category: ${perCategory}` : ''}.`)
    } else {
      lines.push('Suggestions file: none (no precomputed scores).')
    }
    const src = await sourceOf(p)
    const cm = src.columns
    if (!src.extracted) lines.push('', NOT_EXTRACTED_NOTE)
    lines.push('', `Source columns available: code, name${cm.vocabulary ? ', vocabulary_id' : ''}${cm.category ? ', category' : ''}`
      + `${cm.subcategory ? ', subcategory' : ''}${cm.records ? ', record_count' : ''}${cm.patients ? ', patient_count' : ''}`
      + `${cm.info ? ', info_json (metadata)' : ''}.`)
    if (cm.category) {
      const done = (await api.listMappings(p.id)).map((m) => sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode))
      const open = `NOT ${sourceKeysInSql([...new Set(done)], cm.vocabulary)}`
      const records = cm.records
        ? `, SUM(CASE WHEN ${open} AND record_count > 0 THEN 1 ELSE 0 END) AS open_with_records` : ''
      const rows = await src.query(
        `SELECT category, COUNT(*) AS n, SUM(CASE WHEN ${open} THEN 1 ELSE 0 END) AS open${records}
FROM source_concepts GROUP BY category ORDER BY open DESC, n DESC LIMIT 40`)
      lines.push('', `Categories (concepts · unmapped${records ? ' · unmapped with records' : ''}):`, ...rows.map((r) =>
        `  ${String(r.category ?? '(none)')}: ${String(r.n)} · ${String(r.open)}${records ? ` · ${String(r.open_with_records)}` : ''}`))
    }
    return text(lines.join('\n'))
  }))

  server.registerTool('list_source_concepts', {
    description: 'Source concepts of a mapping project, a page at a time, with their counts and a one-line summary of '
      + 'their metadata. Filter by mapping status, category, name, or whether suggestions exist.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string; status?: 'unmapped' | 'mapped' | 'all'; category?: string; search?: string
      with_suggestions?: boolean; sort?: 'records' | 'patients' | 'name'; limit?: number; offset?: number
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        status: { type: 'string', enum: ['unmapped', 'mapped', 'all'], description: 'Default unmapped (ignored ones excluded).' },
        category: { type: 'string', description: 'Exact category, as get_mapping_project lists them.' },
        search: { type: 'string', description: 'Fuzzy match on the concept name.' },
        with_suggestions: { type: 'boolean', description: 'Only concepts that have precomputed or AI suggestions.' },
        sort: { type: 'string', enum: ['records', 'patients', 'name'], description: 'Default records (most frequent first) when counts exist.' },
        limit: { type: 'number', description: 'Default 25, max 100.' },
        offset: { type: 'number' },
      },
      required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id, status = 'unmapped', category, search, with_suggestions, sort, limit = 25, offset = 0 }) => {
    const p = await api.getMappingProject(mapping_project_id)
    const src = await sourceOf(p)
    const cm = src.columns
    const mappings = await api.listMappings(p.id)
    const byKey = new Map<string, ConceptMapping[]>()
    for (const m of mappings) {
      const k = sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode)
      byKey.set(k, [...(byKey.get(k) ?? []), m])
    }
    const filters: SourceConceptFilters = {}
    if (status !== 'all') {
      filters.mappingStatus = status
      filters.mappedKeys = mappings.filter((m) => m.status !== 'ignored').map((m) => sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode))
      filters.ignoredKeys = mappings.filter((m) => m.status === 'ignored').map((m) => sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode))
    }
    if (category) {
      if (!cm.category) return failure('This source has no category column.')
      filters.category = [category]
    }
    if (search?.trim()) filters.searchTextFuzzy = search.trim()
    if (with_suggestions) {
      const index = await api.scoresIndex(p.id)
      filters.hasSuggestionCategoryFilter = true
      filters.suggestionCategoryKeys = (index?.sourceKeys ?? []).map(indexKeyToSourceKey)
    }
    const column = sort === 'name' ? null : sort === 'patients' ? (cm.patients ? 'patient_count' : null)
      : (cm.records ? 'record_count' : null)
    const sorting = column && !filters.searchTextFuzzy ? { columnId: column, desc: true } : null
    const size = Math.min(Math.max(1, Math.floor(limit)), 100)
    const [rows, count] = await Promise.all([
      src.query(buildFileSourceConceptsQuery(filters, sorting, size, Math.max(0, Math.floor(offset)))),
      src.query(buildFileSourceConceptsCountQuery(filters)),
    ])
    const total = Number(count[0]?.total ?? 0)
    if (rows.length === 0) return text(`No source concept matches (${total} in total for these filters).`)
    const body = (rows as SourceRow[]).map((r) => {
      const existing = byKey.get(sourceKeyOf(r.vocabulary_id, r.concept_code))
      return describeSourceRow(r, existing ? statusLabel(existing) : undefined)
    })
    const end = offset + rows.length
    return text(`${total} source concept(s) match; showing ${offset + 1}–${end}.${end < total ? ` Next page: offset ${end}.` : ''}`
      + `${src.extracted ? '' : `\n${NOT_EXTRACTED_NOTE}`}\n\n${body.join('\n')}`)
  }))

  server.registerTool('get_source_concept', {
    description: 'One source concept in full: its metadata (units, value distribution, categories, hospital units…), '
      + 'its existing mappings, and its precomputed / AI suggestions with the target names.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; concept_code: string; vocabulary_id?: string; full_metadata?: boolean }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        concept_code: { type: 'string', description: 'The code, or vocabulary/code as list_source_concepts prints it.' },
        vocabulary_id: { type: 'string', description: 'The source vocabulary, when codes repeat across vocabularies.' },
        full_metadata: { type: 'boolean', description: 'All metadata (per-year distribution, every ward). Default: reduced.' },
      },
      required: ['mapping_project_id', 'concept_code'],
    }),
  }, guard(async ({ mapping_project_id, concept_code, vocabulary_id, full_metadata }) => {
    const p = await api.getMappingProject(mapping_project_id)
    const src = await sourceOf(p)
    const found = (await sourcesByCode(src, [{ code: concept_code, vocabularyId: vocabulary_id }]))(concept_code, vocabulary_id)
    if (typeof found === 'string') return failure(`Not found: ${found}.`)
    const vocab = String(found.vocabulary_id ?? '')
    const lines = [describeSourceRow(found).replace(/^- /, 'Source concept: ')]
    if (found.info_json != null) lines.push('', 'Metadata (info_json):', describeInfo(found.info_json, 4000, full_metadata))
    if (!src.extracted) lines.push('', NOT_EXTRACTED_NOTE)
    const extra = Object.entries(found).filter(([k, v]) =>
      v != null && v !== '' && !['concept_id', 'concept_name', 'concept_code', 'vocabulary_id', 'info_json', 'category',
        'subcategory', 'record_count', 'patient_count', 'terminology_name'].includes(k))
    if (extra.length) lines.push('', `Other columns: ${extra.map(([k, v]) => `${k}=${String(v)}`).join(', ')}`)

    const existing = (await api.listMappings(p.id))
      .filter((m) => m.sourceConceptCode === String(found.concept_code) && (m.sourceVocabularyId ?? '') === vocab)
    lines.push('', existing.length ? 'Existing mappings:' : 'Existing mappings: none.')
    for (const m of existing) {
      lines.push(`  ${effectiveMappingStatus(m)} → ${m.targetConceptId} ${m.targetConceptName} [${m.targetVocabularyId}] `
        + `${m.equivalence}${m.mappedBy ? `, by ${m.mappedBy}` : ''}`)
    }

    const scores = await api.queryScores(p.id, vocab, String(found.concept_code)).catch(() => [])
    if (scores.length === 0) {
      lines.push('', 'Suggestions: none.')
    } else {
      const groups = groupSuggestions(scores).slice(0, 15)
      let names = new Map<number, VocabConcept>()
      try { names = await conceptsById(await vocabularyOf(p), groups.map((g) => g.conceptId)) } catch { /* names optional */ }
      lines.push('', `Suggestions (${groups.length} best targets of ${new Set(scores.map((s) => s.concept_id)).size}):`)
      for (const g of groups) {
        const c = names.get(g.conceptId)
        lines.push(`  ${c ? describeConcept(c) : g.conceptId}`)
        lines.push(`    ${g.rows.map((r) => `${r.method} ${r.score.toFixed(2)}${r.method.startsWith('ai/') ? ` ${r.equivalence}` : ''}`).join(' · ')}`)
        const comment = g.rows.find((r) => r.comment)?.comment
        if (comment) lines.push(`    “${comment}”`)
      }
    }
    return text(lines.join('\n'))
  }))

  server.registerTool('search_vocabulary', {
    description: 'Search target concepts in the project\'s OMOP vocabulary database, by name, code or id (fuzzy, '
      + 'English names), plus synonyms. Standard concepts only by default. concept_set_id restricts the search to a '
      + 'concept set\'s resolved concepts (data-dictionary mode).',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string; query: string; domains?: string[]; vocabularies?: string[]; concept_classes?: string[]
      standard?: 'S' | 'C' | 'any'; concept_set_id?: string; limit?: number
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        query: { type: 'string', description: 'English words, a concept code, or a concept id. Empty lists a concept set.' },
        domains: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Measurement"].' },
        vocabularies: { type: 'array', items: { type: 'string' }, description: 'e.g. ["LOINC", "SNOMED"].' },
        concept_classes: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Clinical Drug"].' },
        standard: { type: 'string', enum: ['S', 'C', 'any'], description: 'Default S (standard).' },
        concept_set_id: { type: 'string', description: 'Only this concept set\'s resolved concepts.' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
      },
      required: ['mapping_project_id', 'query'],
    }),
  }, guard(async ({ mapping_project_id, query, domains, vocabularies, concept_classes, standard = 'S', concept_set_id, limit = 20 }) => {
    const p = await api.getMappingProject(mapping_project_id)
    const v = await vocabularyOf(p)
    const size = Math.min(Math.max(1, Math.floor(limit)), 100)
    let conceptIds: number[] | undefined
    if (concept_set_id) {
      const set = await api.getConceptSet(concept_set_id)
      conceptIds = set.resolvedConceptIds ?? set.expression.items.filter((i) => !i.isExcluded).map((i) => i.concept.conceptId)
    }
    const sql = buildStandardConceptSearchQuery(v.mapping, query, {
      domainIds: domains, vocabularyIds: vocabularies, conceptClassIds: concept_classes,
      standardConcepts: standard === 'any' ? undefined : [standard], conceptIds,
    }, size)
    const hits = (await api.query(v.databaseId, sql)) as unknown as VocabConcept[]
    const seen = new Set(hits.map((h) => Number(h.concept_id)))
    const lines = hits.map((h) => `- ${describeConcept({ ...h, concept_id: Number(h.concept_id) })}`)
    const synSql = !conceptIds && !domains?.length && !vocabularies?.length && !concept_classes?.length
      ? synonymSearchSql(v.table, query, standard === 'S', size) : null
    if (synSql) {
      try {
        const syn = (await api.query(v.databaseId, synSql)) as unknown as (VocabConcept & { synonym: string })[]
        const extra = syn.filter((s) => !seen.has(Number(s.concept_id)))
        if (extra.length) {
          lines.push('', 'Found through a synonym:', ...extra.map((s) =>
            `- ${describeConcept({ ...s, concept_id: Number(s.concept_id) })} — synonym "${s.synonym}"`))
        }
      } catch { /* no concept_synonym table */ }
    }
    if (lines.length === 0) {
      return text(`No concept matches "${query}". Try English clinical terms, fewer words, or a broader filter.`)
    }
    return text(lines.join('\n'))
  }))

  server.registerTool('get_vocabulary_concept', {
    description: 'One target concept with its relationships (e.g. "Maps to" from a non-standard concept to its standard '
      + 'one), synonyms, ancestors and descendants — to pick the right level of specificity.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; concept_id: number | string }>({
      type: 'object',
      properties: { mapping_project_id: { type: 'string' }, concept_id: { type: ['number', 'string'] } },
      required: ['mapping_project_id', 'concept_id'],
    }),
  }, guard(async ({ mapping_project_id, concept_id }) => {
    const id = Number(concept_id)
    if (!Number.isInteger(id)) return failure('concept_id must be an integer.')
    const v = await vocabularyOf(await api.getMappingProject(mapping_project_id))
    const concept = (await conceptsById(v, [id])).get(id)
    if (!concept) return failure(`Concept ${id} is not in the vocabulary database.`)
    const lines = [describeConcept(concept)]
    const section = async (title: string, sql: string, format: (r: Record<string, unknown>) => string, max: number) => {
      try {
        const rows = await api.query(v.databaseId, sql)
        if (rows.length) {
          lines.push('', `${title}${rows.length > max ? ` (${max} of ${rows.length})` : ''}:`, ...rows.slice(0, max).map(format))
        }
      } catch { /* the vocabulary lacks that table */ }
    }
    const asConcept = (r: Record<string, unknown>) => `  ${describeConcept({ ...(r as unknown as VocabConcept), concept_id: Number(r.concept_id) })}`
    try {
      const rows = sortRelations(await api.query(v.databaseId, buildConceptRelationsQuery(id, v.table)))
      if (rows.length) {
        const counts = new Map<string, number>()
        for (const r of rows) counts.set(String(r.relationship_id), (counts.get(String(r.relationship_id)) ?? 0) + 1)
        lines.push('', `Relationships (${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}):`,
          ...rows.slice(0, 30).map((r) => `  ${String(r.relationship_id)}: ${asConcept(r).trim()}`))
        if (rows.length > 30) lines.push(`  … ${rows.length - 30} more`)
      }
    } catch { /* no concept_relationship table */ }
    await section('Synonyms', buildConceptSynonymsQuery(id), (r) =>
      `  ${String(r.concept_synonym_name)}${r.language_name ? ` (${String(r.language_name)})` : ''}`, 20)
    await section('Ancestors (nearest first)', buildConceptAncestorsQuery(id, v.table), asConcept, 12)
    await section('Descendants (nearest first)', buildConceptDescendantsQuery(id, v.table), asConcept, 15)
    await section('Descendant count', buildConceptDescendantCountQuery(id), (r) => `  ${String(r.cnt)}`, 1)
    return text(lines.join('\n'))
  }))

  server.registerTool('add_ai_suggestions', {
    description: 'Leave AI suggestions on source concepts: they appear in the app\'s Suggestions panel (category '
      + '"AI"), where a reviewer accepts or rejects them. Writes nothing else. All-or-nothing: if one item is invalid, '
      + 'nothing is written. An existing suggestion (same source, target and model) is kept, never overwritten.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; model: string; suggestions: SuggestionInput[] }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        model: { type: 'string', description: 'Your model name (e.g. "qwen3-235b"); the method becomes ai/<model>.' },
        suggestions: {
          type: 'array',
          description: `Up to ${MAX_WRITE}. Several candidates per source concept are allowed (best first, lower scores for weaker ones).`,
          items: {
            type: 'object',
            properties: {
              concept_code: { type: 'string', description: 'Source concept code (or vocabulary/code as listed).' },
              vocabulary_id: { type: 'string', description: 'Source vocabulary, when codes repeat across vocabularies.' },
              concept_id: { type: ['number', 'string'], description: 'Standard OMOP target concept id.' },
              score: { type: ['number', 'string'], description: 'Your confidence, 0–1.' },
              equivalence: { type: 'string', enum: ['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch'] },
              comment: { type: 'string', description: 'One or two sentences a reviewer can agree with; for an inexact match, say what is lost.' },
              concept_set_id: { type: 'string', description: 'The concept set (data dictionary) the target was taken from, if any.' },
            },
            required: ['concept_code', 'concept_id', 'score', 'equivalence', 'comment'],
          },
        },
      },
      required: ['mapping_project_id', 'model', 'suggestions'],
    }),
  }, guard(async ({ mapping_project_id, model, suggestions }) => {
    if (!model?.trim()) return failure('model is required.')
    if (!suggestions?.length) return failure('No suggestion given.')
    if (suggestions.length > MAX_WRITE) return failure(`At most ${MAX_WRITE} suggestions per call.`)
    const p = await api.getMappingProject(mapping_project_id)
    const src = await sourceOf(p)
    const v = await vocabularyOf(p)
    const errors: string[] = []
    const label = (s: SuggestionInput, i: number) => `#${i + 1} (${s.vocabulary_id ? `${s.vocabulary_id}/` : ''}${s.concept_code} → ${s.concept_id})`
    suggestions.forEach((s, i) => errors.push(...checkJudgement(s, label(s, i))))
    const lookup = await sourcesByCode(src, suggestions.map((s) => ({ code: String(s.concept_code), vocabularyId: s.vocabulary_id })))
    const targets = await conceptsById(v, suggestions.map((s) => Number(s.concept_id)))
    const sets = new Map<string, { uid: string | null; repo: string | null }>()
    for (const id of new Set(suggestions.map((s) => s.concept_set_id).filter((x): x is string => !!x))) {
      try {
        const set = await api.getConceptSet(id)
        if (!set.uniqueId) errors.push(`concept set ${id} "${set.name}" has no uniqueId; leave concept_set_id out.`)
        sets.set(id, { uid: set.uniqueId ?? null, repo: set.sourceRepo ?? null })
      } catch {
        errors.push(`concept set ${id} not found.`)
      }
    }
    const now = new Date().toISOString()
    const method = methodForModel(model)
    const rows = suggestions.map((s, i) => {
      const source = lookup(String(s.concept_code), s.vocabulary_id)
      if (typeof source === 'string') errors.push(`${label(s, i)}: ${source}.`)
      const targetError = checkTarget(targets.get(Number(s.concept_id)), Number(s.concept_id), label(s, i))
      if (targetError) errors.push(targetError)
      const set = s.concept_set_id ? sets.get(s.concept_set_id) : undefined
      return {
        sourceVocabularyId: typeof source === 'string' ? '' : String(source.vocabulary_id ?? ''),
        // The resolved code, not the one given: `vocabulary/code` tokens are accepted as input.
        sourceConceptCode: typeof source === 'string' ? String(s.concept_code) : String(source.concept_code ?? ''),
        conceptId: Number(s.concept_id),
        method,
        score: Number(s.score),
        equivalence: s.equivalence,
        comment: s.comment?.trim(),
        createdAt: now,
        conceptSetUid: set?.uid ?? null,
        conceptSetSourceRepo: set?.uid ? set.repo : null,
        sourceConceptName: typeof source === 'string' ? null : String(source.concept_name ?? ''),
        conceptName: targets.get(Number(s.concept_id))?.concept_name ?? null,
      }
    })
    if (errors.length) return failure(`Nothing written. Fix these and send the batch again:\n- ${errors.join('\n- ')}`)
    const result = await api.appendScores(p.id, rows)
    if (result.added === 0) return text(`Nothing new: all ${result.skipped} suggestion(s) were already there, kept as they were.`)
    const sources = new Set(rows.map((r) => `${r.sourceVocabularyId}\0${r.sourceConceptCode}`)).size
    return text(`Added ${result.added} suggestion(s) as ${method} on ${sources} source concept(s)`
      + `${result.skipped ? `; ${result.skipped} already there, kept as they were` : ''}. `
      + 'They are in the Suggestions panel of the mapping editor, awaiting review.')
  }))

  server.registerTool('remove_ai_suggestions', {
    description: 'Withdraw AI suggestions from a mapping project: every ai/<model> row of that model, or only those of '
      + 'some source concepts. Precomputed scores and mappings are never touched.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; model: string; concept_codes?: string[] }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        model: { type: 'string', description: 'The model name used when adding them, or the method itself (ai/…).' },
        concept_codes: {
          type: 'array', items: { type: 'string' },
          description: 'Only these source concepts (code or vocabulary/code). All of them when omitted.',
        },
      },
      required: ['mapping_project_id', 'model'],
    }),
  }, guard(async ({ mapping_project_id, model, concept_codes }) => {
    const method = model.trim().startsWith('ai/') ? model.trim() : methodForModel(model)
    const p = await api.getMappingProject(mapping_project_id)
    const index = await api.scoresIndex(p.id)
    if (!index?.methods.includes(method)) {
      const ai = index?.methods.filter((m) => m.startsWith('ai/')) ?? []
      return failure(`No suggestion of ${method} in this project.${ai.length ? ` AI methods present: ${ai.join(', ')}.` : ''}`)
    }
    let sources: { vocabularyId: string; conceptCode: string }[] | undefined
    if (concept_codes?.length) {
      const lookup = await sourcesByCode(await sourceOf(p), concept_codes.map((code) => ({ code })))
      const errors: string[] = []
      sources = []
      for (const code of concept_codes) {
        const found = lookup(code)
        if (typeof found === 'string') errors.push(found)
        else sources.push({ vocabularyId: String(found.vocabulary_id ?? ''), conceptCode: String(found.concept_code ?? '') })
      }
      if (errors.length) return failure(`Nothing removed:\n- ${errors.join('\n- ')}`)
    }
    const { removed } = await api.removeScores(p.id, [method], sources)
    return text(removed ? `Removed ${removed} suggestion(s) of ${method}.` : `No suggestion of ${method} matched.`)
  }))

  server.registerTool('find_sources_for_targets', {
    description: 'The reverse lookup: which source concepts precomputed or AI suggestions link to given target '
      + 'concepts — a concept set\'s resolved concepts, or explicit ids. Serves aligning a data dictionary set by set.',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string; concept_ids?: (number | string)[]; concept_set_id?: string; min_score?: number | string
      methods?: string[]
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        concept_ids: { type: 'array', items: { type: ['number', 'string'] }, description: 'Target concept ids.' },
        concept_set_id: { type: 'string', description: 'Or a concept set: its resolved concepts are the targets.' },
        min_score: { type: ['number', 'string'], description: 'Default 0.5.' },
        methods: { type: 'array', items: { type: 'string' }, description: 'e.g. ["semantic/biolord"]. Default: all.' },
      },
      required: ['mapping_project_id'],
    }),
  }, guard(async ({ mapping_project_id, concept_ids, concept_set_id, min_score = 0.5, methods }) => {
    let ids = (concept_ids ?? []).map(Number).filter(Number.isInteger)
    if (concept_set_id) {
      const set = await api.getConceptSet(concept_set_id)
      ids = [...ids, ...(set.resolvedConceptIds ?? set.expression.items.filter((i) => !i.isExcluded).map((i) => i.concept.conceptId))]
    }
    if (ids.length === 0) return failure('Give concept_ids or a concept_set_id with concepts.')
    const p = await api.getMappingProject(mapping_project_id)
    const rows = await api.scoresByTarget(p.id, [...new Set(ids)], Number(min_score), methods)
    if (rows.length === 0) return text(`No suggestion reaches these ${ids.length} target(s) with a score ≥ ${min_score}.`)
    const src = await sourceOf(p)
    const lookup = await sourcesByCode(src, rows.map((r) => ({ code: r.source_concept_code, vocabularyId: r.source_vocabulary_id })))
    const mapped = new Set((await api.listMappings(p.id)).map((m) => sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode)))
    let names = new Map<number, VocabConcept>()
    try { names = await conceptsById(await vocabularyOf(p), [...new Set(rows.map((r) => r.concept_id))]) } catch { /* names optional */ }
    const byTarget = new Map<number, typeof rows>()
    for (const r of rows) byTarget.set(r.concept_id, [...(byTarget.get(r.concept_id) ?? []), r])
    const lines = [`${rows.length} suggestion(s) reach ${byTarget.size} of the ${new Set(ids).size} target(s):`]
    for (const [conceptId, rs] of byTarget) {
      const c = names.get(conceptId)
      lines.push('', c ? describeConcept(c) : String(conceptId))
      const seen = new Set<string>()
      for (const r of rs) {
        const key = sourceKeyOf(r.source_vocabulary_id, r.source_concept_code)
        if (seen.has(key)) continue
        seen.add(key)
        const source = lookup(r.source_concept_code, r.source_vocabulary_id)
        const name = typeof source === 'string' ? '' : ` ${String(source.concept_name ?? '')}`
        const methodsHere = rs.filter((x) => sourceKeyOf(x.source_vocabulary_id, x.source_concept_code) === key)
          .map((x) => `${x.method} ${x.score.toFixed(2)}`).join(', ')
        lines.push(`  ${r.source_vocabulary_id}/${r.source_concept_code}${name} — ${methodsHere}${mapped.has(key) ? ' · already mapped' : ''}`)
      }
    }
    return text(lines.join('\n'))
  }))

  server.registerTool('create_mappings', {
    description: 'Write mappings (status "unchecked", to be reviewed in Linkr). Only for picks the user explicitly '
      + 'confirmed — otherwise use add_ai_suggestions. A source concept that already has a mapping is skipped. '
      + 'status "ignored" marks a concept as not to be mapped (no concept_id).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      mapping_project_id: string; mapped_by?: 'me' | 'model'; model?: string
      mappings: {
        concept_code: string; vocabulary_id?: string; concept_id?: number | string; equivalence?: string
        comment: string; match_score?: number | string; status?: 'unchecked' | 'flagged' | 'ignored'
      }[]
    }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        mapped_by: { type: 'string', enum: ['me', 'model'], description: 'Author: the user (default) or the model.' },
        model: { type: 'string', description: 'Your model name, required when mapped_by is "model".' },
        mappings: {
          type: 'array',
          description: `Up to ${MAX_WRITE}.`,
          items: {
            type: 'object',
            properties: {
              concept_code: { type: 'string' },
              vocabulary_id: { type: 'string' },
              concept_id: { type: ['number', 'string'], description: 'Standard OMOP target; omit for status "ignored".' },
              equivalence: { type: 'string', enum: ['skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch'] },
              comment: { type: 'string' },
              match_score: { type: ['number', 'string'], description: 'Confidence 0–1.' },
              status: { type: 'string', enum: ['unchecked', 'flagged', 'ignored'], description: 'Default unchecked.' },
            },
            required: ['concept_code', 'comment'],
          },
        },
      },
      required: ['mapping_project_id', 'mappings'],
    }),
  }, guard(async ({ mapping_project_id, mapped_by = 'me', model, mappings }) => {
    if (!mappings?.length) return failure('No mapping given.')
    if (mappings.length > MAX_WRITE) return failure(`At most ${MAX_WRITE} mappings per call.`)
    if (mapped_by === 'model' && !model?.trim()) return failure('model is required when mapped_by is "model".')
    const p = await api.getMappingProject(mapping_project_id)
    const src = await sourceOf(p)
    const v = await vocabularyOf(p)
    const me = await api.me()
    const author = mapped_by === 'model' ? model!.trim() : (`${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || me.username)
    const errors: string[] = []
    const label = (m: { concept_code: string; vocabulary_id?: string }, i: number) =>
      `#${i + 1} (${m.vocabulary_id ? `${m.vocabulary_id}/` : ''}${m.concept_code})`
    const lookup = await sourcesByCode(src, mappings.map((m) => ({ code: String(m.concept_code), vocabularyId: m.vocabulary_id })))
    const targets = await conceptsById(v, mappings.map((m) => Number(m.concept_id)))
    const existing = new Set((await api.listMappings(p.id)).filter((m) => m.status !== 'rejected')
      .map((m) => sourceKeyOf(m.sourceVocabularyId, m.sourceConceptCode)))
    const now = new Date().toISOString()
    const payloads: Record<string, unknown>[] = []
    const skipped: string[] = []
    const batchKeys = new Set<string>()
    mappings.forEach((m, i) => {
      const status = m.status ?? 'unchecked'
      const ignored = status === 'ignored'
      errors.push(...checkJudgement({
        equivalence: ignored ? 'skos:relatedMatch' : m.equivalence, comment: m.comment, score: m.match_score,
      }, label(m, i)))
      const source = lookup(String(m.concept_code), m.vocabulary_id)
      if (typeof source === 'string') { errors.push(`${label(m, i)}: ${source}.`); return }
      let target: VocabConcept | null = null
      if (!ignored) {
        const id = Number(m.concept_id)
        const targetError = checkTarget(targets.get(id), id, label(m, i))
        if (targetError) { errors.push(targetError); return }
        target = targets.get(id)!
      }
      const key = sourceKeyOf(source.vocabulary_id, source.concept_code)
      if (existing.has(key) || batchKeys.has(key)) { skipped.push(label(m, i)); return }
      batchKeys.add(key)
      payloads.push(mappingPayload({
        id: randomUUID(), projectId: p.id, source, target,
        equivalence: (ignored ? (m.equivalence ?? 'skos:relatedMatch') : m.equivalence) as MappingEquivalence,
        status, comment: m.comment, author, now,
        ...(m.match_score !== undefined ? { matchScore: Number(m.match_score) } : {}),
      }))
    })
    if (errors.length) return failure(`Nothing written. Fix these and send the batch again:\n- ${errors.join('\n- ')}`)
    if (payloads.length) {
      await api.createMappings(payloads)
      await refreshStats(p)
    }
    const skippedNote = skipped.length ? `Skipped (already mapped): ${skipped.join(', ')}` : ''
    if (payloads.length === 0) return text(`Nothing created. ${skippedNote}`)
    return text(`Created ${payloads.length} mapping(s) by ${author}, awaiting review in Linkr.${skippedNote ? `\n${skippedNote}` : ''}`)
  }))
}
