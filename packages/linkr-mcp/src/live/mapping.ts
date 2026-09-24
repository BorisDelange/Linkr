/** Pure helpers for concept mapping: source rows, suggestions, and mapping payloads. */
import type { ConceptMapping, MappingEquivalence } from '@/types'
import { escSql } from '@/lib/format-helpers'
import type { ScoreRow } from './api.js'

export const EQUIVALENCES: MappingEquivalence[] = [
  'skos:exactMatch', 'skos:closeMatch', 'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch',
]

/** A row of the `source_concepts` view; columns beyond name and code exist only when mapped. */
export type SourceRow = Record<string, unknown> & { concept_name?: string; concept_code?: string }

/** A target concept read from the vocabulary database. */
export interface VocabConcept {
  concept_id: number
  concept_name: string
  vocabulary_id: string
  domain_id?: string | null
  concept_class_id?: string | null
  concept_code?: string | null
  standard_concept?: string | null
  invalid_reason?: string | null
}

/** The `vocabulary\0code` key the app's SQL filters and mapping stats use. */
export const sourceKeyOf = (vocabularyId: unknown, code: unknown) => `${vocabularyId ?? ''}\0${code ?? ''}`

/** Scores index keys are `vocabulary::code`; the SQL filters want `vocabulary\0code`. */
export const indexKeyToSourceKey = (key: string) => {
  const i = key.indexOf('::')
  return i < 0 ? `\0${key}` : `${key.slice(0, i)}\0${key.slice(i + 2)}`
}

/** `ai/<model>` with the model name made safe for a method column. */
export function methodForModel(model: string): string {
  const slug = model.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '')
  return `ai/${slug || 'unknown'}`
}

export function parseInfo(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null)

/**
 * One line out of a concept's metadata (`info_json`): what a reviewer glances at
 * to tell two near-identical targets apart — type, unit, range, top values.
 */
export function infoSummary(raw: unknown): string {
  const info = parseInfo(raw)
  if (!info) return ''
  const parts: string[] = []
  if (typeof info.data_types === 'string') parts.push(info.data_types)
  // `numeric_data` + top-level `unit` is what Linkr's extraction writes (concept-profile.ts);
  // `numerical_data.unit` is the older hand-made CSV shape.
  const numeric = (info.numeric_data ?? info.numerical_data) as Record<string, unknown> | undefined
  const unit = info.unit ?? numeric?.unit
  if (unit) parts.push(`unit ${String(unit)}`)
  if (numeric && typeof numeric === 'object') {
    const [min, med, max] = [num(numeric.min), num(numeric.median ?? numeric.mean), num(numeric.max)]
    const [p5, p95] = [num(numeric.p5), num(numeric.p95)]
    if (min && max) parts.push(`range ${min}–${max}${med ? `, median ${med}` : ''}${p5 && p95 ? `, p5–p95 ${p5}–${p95}` : ''}`)
  }
  const categorical = info.categorical_data
  if (Array.isArray(categorical) && categorical.length) {
    const values = categorical.slice(0, 5).map((c) => String((c as Record<string, unknown>).category ?? (c as Record<string, unknown>).value ?? c))
    parts.push(`values ${values.join(', ')}${categorical.length > 5 ? ', …' : ''}`)
  }
  if (typeof info.full_name === 'string' && info.full_name) parts.push(`path ${info.full_name}`)
  return parts.join(' · ')
}

/**
 * The metadata, readable, cut to a budget. By default the bulky blocks that
 * rarely decide a target are reduced: no histogram (the percentiles say it),
 * the date range without the per-year breakdown, the top three wards.
 */
export function describeInfo(raw: unknown, maxChars = 4000, full = false): string {
  const info = parseInfo(raw)
  if (!info) return typeof raw === 'string' && raw.trim() ? raw.slice(0, maxChars) : '(none)'
  const { histogram: _histogram, ...rest } = info
  if (!full) {
    const temporal = rest.temporal_distribution as Record<string, unknown> | undefined
    if (temporal && typeof temporal === 'object') {
      rest.temporal_distribution = { start_date: temporal.start_date, end_date: temporal.end_date }
    }
    if (Array.isArray(rest.hospital_units) && rest.hospital_units.length > 3) {
      rest.hospital_units = [...rest.hospital_units.slice(0, 3), `… ${rest.hospital_units.length - 3} more`]
    }
    if (Array.isArray(rest.categorical_data) && rest.categorical_data.length > 15) {
      rest.categorical_data = [...rest.categorical_data.slice(0, 15), `… ${rest.categorical_data.length - 15} more`]
    }
  }
  const body = JSON.stringify(rest, null, 1)
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}\n… (${body.length - maxChars} more characters cut)`
}

export function describeSourceRow(row: SourceRow, status?: string): string {
  const vocab = row.vocabulary_id ? `${String(row.vocabulary_id)}/` : ''
  const counts = [
    row.record_count != null ? `${String(row.record_count)} records` : null,
    row.patient_count != null ? `${String(row.patient_count)} patients` : null,
  ].filter(Boolean).join(', ')
  const category = [row.category, row.subcategory].filter((v) => v).map(String).join(' / ')
  const summary = infoSummary(row.info_json)
  return `- ${vocab}${row.concept_code ?? ''} — ${row.concept_name ?? ''}`
    + `${category ? ` [${category}]` : ''}${counts ? ` · ${counts}` : ''}${status ? ` · ${status}` : ''}`
    + `${summary ? `\n    ${summary}` : ''}`
}

export function describeConcept(c: VocabConcept): string {
  const flags = [
    c.domain_id, c.concept_class_id,
    c.standard_concept === 'S' ? 'standard' : c.standard_concept === 'C' ? 'classification' : 'non-standard',
    c.invalid_reason ? `INVALID (${c.invalid_reason})` : null,
  ].filter(Boolean)
  return `${c.concept_id} — ${c.concept_name} [${c.vocabulary_id}${c.concept_code ? ` ${c.concept_code}` : ''}] (${flags.join(', ')})`
}

/** Concepts by id, from an OMOP vocabulary's concept table. */
export function conceptsByIdSql(table: string, ids: number[]): string {
  return `SELECT concept_id, concept_name, vocabulary_id, domain_id, concept_class_id, concept_code, standard_concept, invalid_reason
FROM ${table} WHERE concept_id IN (${ids.join(',')})`
}

/** Standard concepts whose synonyms hold every word of `term` (accents and case ignored). */
export function synonymSearchSql(table: string, term: string, standardOnly: boolean, limit: number): string | null {
  const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  if (words.length === 0) return null
  const conds = words.map((w) => `strip_accents(lower(cs.concept_synonym_name)) LIKE '%' || strip_accents('${escSql(w)}') || '%'`)
  return `SELECT c.concept_id, c.concept_name, c.vocabulary_id, c.domain_id, c.concept_class_id, c.concept_code,
  c.standard_concept, c.invalid_reason, MIN(cs.concept_synonym_name) AS synonym
FROM concept_synonym cs JOIN ${table} c ON c.concept_id = cs.concept_id
WHERE ${conds.join(' AND ')}${standardOnly ? " AND c.standard_concept = 'S'" : ''}
GROUP BY ALL ORDER BY length(MIN(cs.concept_synonym_name)), c.concept_id LIMIT ${limit}`
}

/**
 * The ways a source reference given by an agent can be read. Listings print a
 * concept as `vocabulary/code`, and agents paste that whole token as the code:
 * without an explicit vocabulary, `a/b` is also tried as vocabulary `a`, code `b`
 * (after the code as given, since a code may itself contain a slash).
 */
export function sourceRefCandidates(code: string, vocabularyId?: string | null): { code: string; vocabularyId?: string | null }[] {
  const refs: { code: string; vocabularyId?: string | null }[] = [{ code, vocabularyId }]
  const slash = code.indexOf('/')
  if (!vocabularyId && slash > 0 && slash < code.length - 1) {
    refs.push({ code: code.slice(slash + 1), vocabularyId: code.slice(0, slash) })
  }
  return refs
}

/** SQL predicate: the row's source key is one of `keys` (`vocabulary\0code`). */
export function sourceKeysInSql(keys: string[], hasVocabulary: boolean): string {
  if (keys.length === 0) return 'FALSE'
  const parsed = keys.map((k) => {
    const i = k.indexOf('\0')
    return { vocab: k.slice(0, i), code: k.slice(i + 1) }
  })
  if (!hasVocabulary) return `concept_code IN (${[...new Set(parsed.map((p) => `'${escSql(p.code)}'`))].join(',')})`
  return `(vocabulary_id, concept_code) IN (${parsed.map((p) => `('${escSql(p.vocab)}','${escSql(p.code)}')`).join(',')})`
}

/** A source concept's lookup by code, and by vocabulary when the source has one. */
export function sourceByCodesSql(codes: { code: string; vocabularyId?: string | null }[], hasVocabulary: boolean): string {
  const conds = codes.map(({ code, vocabularyId }) =>
    hasVocabulary && vocabularyId
      ? `(vocabulary_id = '${escSql(vocabularyId)}' AND concept_code = '${escSql(code)}')`
      : `concept_code = '${escSql(code)}'`)
  return `SELECT * FROM source_concepts WHERE ${conds.join(' OR ')}`
}

/** Precomputed and agent suggestions for one source, grouped by target and best first. */
export function groupSuggestions(rows: ScoreRow[]): { conceptId: number; best: number; rows: ScoreRow[] }[] {
  const byConcept = new Map<number, ScoreRow[]>()
  for (const r of rows) byConcept.set(r.concept_id, [...(byConcept.get(r.concept_id) ?? []), r])
  return [...byConcept.entries()]
    .map(([conceptId, rs]) => ({ conceptId, best: Math.max(...rs.map((r) => r.score)), rows: rs.sort((a, b) => b.score - a.score) }))
    .sort((a, b) => b.best - a.best)
}

export interface SuggestionInput {
  concept_code: string
  vocabulary_id?: string
  concept_id: number | string
  score: number | string
  equivalence: string
  comment: string
  concept_set_id?: string
}

/** Problems with one suggestion or mapping, before anything is looked up. */
export function checkJudgement(item: { equivalence?: string; comment?: string; score?: number | string }, label: string): string[] {
  const errors: string[] = []
  if (!EQUIVALENCES.includes(item.equivalence as MappingEquivalence)) {
    errors.push(`${label}: equivalence must be one of ${EQUIVALENCES.join(', ')}.`)
  }
  if (!item.comment?.trim()) errors.push(`${label}: a comment justifying the match is required.`)
  if (item.score !== undefined) {
    const score = Number(item.score)
    if (!Number.isFinite(score) || score < 0 || score > 1) errors.push(`${label}: score must be between 0 and 1.`)
  }
  return errors
}

/** Problems with a target concept for an OMOP mapping. */
export function checkTarget(concept: VocabConcept | undefined, conceptId: number, label: string): string | null {
  if (!concept) return `${label}: concept ${conceptId} is not in the vocabulary database.`
  if (concept.invalid_reason) return `${label}: concept ${conceptId} is invalid (${concept.invalid_reason}); pick its replacement.`
  // OMOP leaves standard_concept NULL on non-standard concepts; undefined means the column is absent.
  if (concept.standard_concept !== undefined && concept.standard_concept !== 'S') {
    return `${label}: concept ${conceptId} "${concept.concept_name}" is not standard; use get_vocabulary_concept to follow its "Maps to" target.`
  }
  return null
}

/** The mapping row the app itself would write for this source → target pick. */
export function mappingPayload(args: {
  id: string
  projectId: string
  source: SourceRow
  target: VocabConcept | null
  equivalence: MappingEquivalence
  status: 'unchecked' | 'flagged' | 'ignored'
  comment: string
  matchScore?: number
  author: string
  now: string
}): Omit<ConceptMapping, 'updatedAt' | 'createdAt'> & { createdAt: string; updatedAt: string } {
  const { source: s, target: t } = args
  return {
    id: args.id,
    projectId: args.projectId,
    sourceConceptId: Number(s.concept_id ?? 0),
    sourceConceptName: String(s.concept_name ?? ''),
    sourceVocabularyId: String(s.vocabulary_id ?? ''),
    sourceDomainId: String(s.domain_id ?? ''),
    sourceConceptCode: String(s.concept_code ?? ''),
    ...(s.record_count != null ? { sourceFrequency: Number(s.record_count) } : {}),
    ...(s.category ? { sourceCategoryId: String(s.category) } : {}),
    ...(s.subcategory ? { sourceSubcategoryId: String(s.subcategory) } : {}),
    ...(s.concept_class_id ? { sourceConceptClassId: String(s.concept_class_id) } : {}),
    targetConceptId: t?.concept_id ?? 0,
    targetConceptName: t?.concept_name ?? '',
    targetVocabularyId: t?.vocabulary_id ?? '',
    targetDomainId: t?.domain_id ?? '',
    targetConceptCode: t?.concept_code ?? '',
    ...(t?.concept_class_id ? { targetConceptClassId: t.concept_class_id } : {}),
    ...(t?.standard_concept ? { targetStandardConcept: t.standard_concept } : {}),
    mappingType: 'maps_to',
    equivalence: args.equivalence,
    status: args.status,
    ...(args.matchScore !== undefined ? { matchScore: args.matchScore } : {}),
    // Authored by the mapper, so the mapping stays editable (see isMappingLocked).
    comments: [{ id: `${args.id}-c0`, authorId: args.author, text: args.comment.trim(), createdAt: args.now }],
    mappedBy: args.author,
    mappedOn: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  }
}
