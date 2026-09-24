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
  buildFileSourceConceptsCountQuery, buildFileSourceConceptsQuery, buildStandardConceptSearchQuery,
  type SourceConceptFilters,
} from '@/lib/concept-mapping/mapping-queries'
import { effectiveMappingStatus, getTotalSourceConcepts, readsFromFlatSource } from '@/lib/concept-mapping/mapping-status'
import {
  checkJudgement, checkTarget, conceptsByIdSql, describeConcept, describeInfo, describeSourceRow, groupSuggestions,
  indexKeyToSourceKey, mappingPayload, methodForModel, sourceByCodesSql, sourceKeyOf, synonymSearchSql,
  type SourceRow, type SuggestionInput, type VocabConcept,
} from './mapping.js'
import { READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'

const MAX_WRITE = 200

interface Vocabulary { databaseId: string; mapping: SchemaMapping; table: string }

/** An OMOP vocabulary table: the `concept` table, or one mapped with a standard_concept column. */
const isOmopConceptTable = (t: { table?: string; extraColumns?: Record<string, string> }) =>
  t.table === 'concept' || !!t.extraColumns?.standard_concept

async function vocabularyOf(project: MappingProject): Promise<Vocabulary> {
  const databaseId = project.vocabularyDataSourceId || project.dataSourceId
  const ds = databaseId ? await api.getDataSource(databaseId) : null
  const tables = ds?.schemaMapping?.conceptTables ?? []
  const index = tables.findIndex(isOmopConceptTable)
  if (!ds?.schemaMapping || index < 0) {
    throw new Error(`${project.vocabularyDataSourceId ? 'The vocabulary database' : 'This project has no vocabulary database, and its source database'} `
      + `${ds ? `"${loc(ds.name)}" ` : ''}has no OMOP concept table. Ask the user to pick an OMOP vocabulary database `
      + '(e.g. an ATHENA import) in the mapping project\'s settings in Linkr.')
  }
  // The search builder reads the first concept table: put the OMOP one first.
  const mapping = { ...ds.schemaMapping, conceptTables: [tables[index], ...tables.filter((_, i) => i !== index)] }
  return { databaseId: ds.id, mapping, table: tables[index].table ?? 'concept' }
}

/** The source is read from its flat table; a database project must extract it first. */
function requireFlat(project: MappingProject) {
  if (!readsFromFlatSource(project)) {
    throw new Error('This project reads its source concepts straight from a database that has not been extracted yet. '
      + 'Ask the user to run the extraction in Linkr (mapping project → Source concepts tab), then try again.')
  }
}

const hasVocabularyColumn = (p: MappingProject) => !!p.fileSourceData?.columnMapping?.terminologyColumn

async function conceptsById(v: Vocabulary, ids: number[]): Promise<Map<number, VocabConcept>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
  if (unique.length === 0) return new Map()
  const rows = await api.query(v.databaseId, conceptsByIdSql(v.table, unique)) as unknown as VocabConcept[]
  return new Map(rows.map((r) => [Number(r.concept_id), { ...r, concept_id: Number(r.concept_id) }]))
}

async function sourcesByCode(project: MappingProject, codes: { code: string; vocabularyId?: string | null }[]) {
  const hasVocabulary = hasVocabularyColumn(project)
  const rows = codes.length ? await api.queryMappingSource(project.id, sourceByCodesSql(codes, hasVocabulary)) as SourceRow[] : []
  const byKey = new Map<string, SourceRow>()
  const byCode = new Map<string, SourceRow[]>()
  for (const r of rows) {
    byKey.set(sourceKeyOf(r.vocabulary_id, r.concept_code), r)
    byCode.set(String(r.concept_code), [...(byCode.get(String(r.concept_code)) ?? []), r])
  }
  /** The row for a code, or why there is none (unknown, or ambiguous without a vocabulary). */
  return (code: string, vocabularyId?: string | null): SourceRow | string => {
    if (hasVocabulary && vocabularyId) return byKey.get(sourceKeyOf(vocabularyId, code)) ?? `no source concept ${vocabularyId}/${code}`
    const matches = byCode.get(code) ?? []
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) return `no source concept with code ${code}`
    return `code ${code} exists in several vocabularies (${matches.map((m) => String(m.vocabulary_id)).join(', ')}): give vocabulary_id`
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
    if (!readsFromFlatSource(p)) {
      lines.push('', 'Source: a database whose concepts have not been extracted yet — ask the user to run the extraction in Linkr.')
      return text(lines.join('\n'))
    }
    const cm = p.fileSourceData?.columnMapping ?? {}
    lines.push('', `Source columns available: code, name${cm.terminologyColumn ? ', vocabulary_id' : ''}${cm.categoryColumn ? ', category' : ''}`
      + `${cm.subcategoryColumn ? ', subcategory' : ''}${cm.recordCountColumn ? ', record_count' : ''}${cm.patientCountColumn ? ', patient_count' : ''}`
      + `${cm.infoJsonColumn ? ', info_json (metadata)' : ''}.`)
    if (cm.categoryColumn) {
      const records = cm.recordCountColumn ? ', SUM(record_count) AS records' : ''
      const rows = await api.queryMappingSource(p.id,
        `SELECT category, COUNT(*) AS n${records} FROM source_concepts GROUP BY category ORDER BY n DESC LIMIT 40`)
      lines.push('', 'Categories:', ...rows.map((r) =>
        `  ${String(r.category ?? '(none)')}: ${String(r.n)} concepts${r.records != null ? `, ${String(r.records)} records` : ''}`))
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
    requireFlat(p)
    const cm = p.fileSourceData?.columnMapping ?? {}
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
      if (!cm.categoryColumn) return failure('This source has no category column.')
      filters.category = [category]
    }
    if (search?.trim()) filters.searchTextFuzzy = search.trim()
    if (with_suggestions) {
      const index = await api.scoresIndex(p.id)
      filters.hasSuggestionCategoryFilter = true
      filters.suggestionCategoryKeys = (index?.sourceKeys ?? []).map(indexKeyToSourceKey)
    }
    const column = sort === 'name' ? null : sort === 'patients' ? (cm.patientCountColumn ? 'patient_count' : null)
      : (cm.recordCountColumn ? 'record_count' : null)
    const sorting = column && !filters.searchTextFuzzy ? { columnId: column, desc: true } : null
    const size = Math.min(Math.max(1, Math.floor(limit)), 100)
    const [rows, count] = await Promise.all([
      api.queryMappingSource(p.id, buildFileSourceConceptsQuery(filters, sorting, size, Math.max(0, Math.floor(offset)))),
      api.queryMappingSource(p.id, buildFileSourceConceptsCountQuery(filters)),
    ])
    const total = Number(count[0]?.total ?? 0)
    if (rows.length === 0) return text(`No source concept matches (${total} in total for these filters).`)
    const body = (rows as SourceRow[]).map((r) => {
      const existing = byKey.get(sourceKeyOf(r.vocabulary_id, r.concept_code))
      return describeSourceRow(r, existing ? statusLabel(existing) : undefined)
    })
    const end = offset + rows.length
    return text(`${total} source concept(s) match; showing ${offset + 1}–${end}.${end < total ? ` Next page: offset ${end}.` : ''}\n\n${body.join('\n')}`)
  }))

  server.registerTool('get_source_concept', {
    description: 'One source concept in full: its metadata (units, value distribution, categories, hospital units…), '
      + 'its existing mappings, and its precomputed / AI suggestions with the target names.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ mapping_project_id: string; concept_code: string; vocabulary_id?: string }>({
      type: 'object',
      properties: {
        mapping_project_id: { type: 'string' },
        concept_code: { type: 'string' },
        vocabulary_id: { type: 'string', description: 'The source vocabulary, when codes repeat across vocabularies.' },
      },
      required: ['mapping_project_id', 'concept_code'],
    }),
  }, guard(async ({ mapping_project_id, concept_code, vocabulary_id }) => {
    const p = await api.getMappingProject(mapping_project_id)
    requireFlat(p)
    const found = (await sourcesByCode(p, [{ code: concept_code, vocabularyId: vocabulary_id }]))(concept_code, vocabulary_id)
    if (typeof found === 'string') return failure(`Not found: ${found}.`)
    const vocab = String(found.vocabulary_id ?? '')
    const lines = [describeSourceRow(found).replace(/^- /, 'Source concept: ')]
    if (found.info_json != null) lines.push('', 'Metadata (info_json):', describeInfo(found.info_json))
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
              concept_code: { type: 'string', description: 'Source concept code.' },
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
    requireFlat(p)
    const v = await vocabularyOf(p)
    const errors: string[] = []
    const label = (s: SuggestionInput, i: number) => `#${i + 1} (${s.vocabulary_id ? `${s.vocabulary_id}/` : ''}${s.concept_code} → ${s.concept_id})`
    suggestions.forEach((s, i) => errors.push(...checkJudgement(s, label(s, i))))
    const lookup = await sourcesByCode(p, suggestions.map((s) => ({ code: String(s.concept_code), vocabularyId: s.vocabulary_id })))
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
        sourceConceptCode: String(s.concept_code),
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
    requireFlat(p)
    const v = await vocabularyOf(p)
    const me = await api.me()
    const author = mapped_by === 'model' ? model!.trim() : (`${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || me.username)
    const errors: string[] = []
    const label = (m: { concept_code: string; vocabulary_id?: string }, i: number) =>
      `#${i + 1} (${m.vocabulary_id ? `${m.vocabulary_id}/` : ''}${m.concept_code})`
    const lookup = await sourcesByCode(p, mappings.map((m) => ({ code: String(m.concept_code), vocabularyId: m.vocabulary_id })))
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
