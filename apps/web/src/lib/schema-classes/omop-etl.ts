import type { ParsedColumn, ParsedTable } from '@/lib/ddl-parse'
import type { RelationSpec, SchemaMapping } from '@/types/schema-mapping'
import { escSql } from '@/lib/format-helpers'
import { sourceConceptKeyExprs } from '@/lib/concept-mapping/mapping-queries'
import type { ClassName } from './contracts'
import { classRelation, classRelations, conceptJoinOn, eventRelations, has, type ClassRelation } from './relations'
import { fieldRef, specEntries } from './spec'
import { withClassRelations } from './inject'

// ---------------------------------------------------------------------------
// OMOP ETL generation (plan §9). The class contract is a pivot model between
// two databases: the source mapping says how to read each class, the target
// preset's visual mapping says where each contract column lives in OMOP. Its
// plain column references invert, so one INSERT per class composes the two.
// OMOP's own rules (date companions, type concepts, vocabulary joins, NOT NULL
// defaults) live here and nowhere else.
// ---------------------------------------------------------------------------

/** How a source concept becomes an OMOP concept_id. `ccr` and `stcm` read what
 *  the pipeline's generated vocabulary script wrote; `as-is` keeps the source
 *  ids, for a source already coded in the OMOP vocabularies. */
export type EtlConceptMode = 'ccr' | 'stcm' | 'as-is'

export interface OmopEtlOptions {
  /** Named in each script's header. */
  sourceLabel: string
  /** `*_type_concept_id`; 32817 = EHR. */
  typeConceptId?: number
  conceptMode?: EtlConceptMode
  /** Target table per source event/drug relation (by specKey); null skips it. */
  eventTargets?: Record<string, string | null>
}

export interface GeneratedEtlScript {
  name: string
  order: number
  sql: string
  /** specKey of the source relation. */
  source: string
  table: string
}

/** What the generator could not do, for the caller to say in its own words. */
export type OmopEtlWarning =
  | { kind: 'table-not-in-ddl'; table: string }
  | { kind: 'no-target-relation'; relation: string }
  /** `label`: the event or drug table's name, as the mapping calls it. */
  | { kind: 'no-target-table'; relation: string; label: string }

export interface OmopEtlResult {
  scripts: GeneratedEtlScript[]
  warnings: OmopEtlWarning[]
}

const TARGET = 'target'
const EHR_TYPE_CONCEPT = 32817

/** A target relation, inverted: the OMOP column each contract column fills. */
interface InvertedRelation {
  cls: ClassName
  specKey: string
  table: string
  columns: Map<string, string>
  /** Tables the target relation joins and fills fields from (death, care_site):
   *  written by a companion INSERT, keyed by the join's own columns. */
  joins: { table: string; columns: Map<string, string>; keys: [string, string][] }[]
  genderValues?: { male: string; female: string; unknown?: string }
}

function invert(cls: ClassName, specKey: string, spec: RelationSpec): InvertedRelation | null {
  if (spec.customSql?.trim() || !spec.from?.table) return null
  const main = spec.from.alias.toLowerCase()
  const columns = new Map<string, string>()
  const byAlias = new Map<string, Map<string, string>>()
  for (const [contract, field] of Object.entries(spec.fields ?? {})) {
    const ref = fieldRef(field)
    if (!ref) continue
    const alias = ref.alias.toLowerCase()
    if (alias === main) columns.set(contract, ref.column)
    else byAlias.set(alias, (byAlias.get(alias) ?? new Map()).set(contract, ref.column))
  }
  const contractOf = (column: string) => [...columns].find(([, c]) => c === column)?.[0]
  const joins = (spec.joins ?? []).flatMap((j) => {
    const own = byAlias.get(j.alias.toLowerCase())
    if (!own) return []
    const keys: [string, string][] = []
    for (const pair of j.on ?? []) {
      const [a, b] = pair.map(fieldRef)
      if (!a || !b) continue
      const [mine, theirs] = a.alias.toLowerCase() === main ? [a, b] : [b, a]
      const contract = mine.alias.toLowerCase() === main && theirs.alias.toLowerCase() === j.alias.toLowerCase() ? contractOf(mine.column) : undefined
      if (contract) keys.push([theirs.column, contract])
    }
    return keys.length ? [{ table: j.table, columns: own, keys }] : []
  })
  const genderValues = cls === 'patient' ? (spec as { genderValues?: InvertedRelation['genderValues'] }).genderValues : undefined
  return { cls, specKey, table: spec.from.table, columns, joins, genderValues }
}

/** Every invertible relation of the target mapping. */
function targetRelations(target: SchemaMapping): InvertedRelation[] {
  return specEntries(target).flatMap(({ cls, specKey, spec }) => invert(cls, specKey, spec) ?? [])
}

/** The OMOP tables a source event/drug relation can go to, and the default. */
export function eventTargetChoices(source: SchemaMapping, target: SchemaMapping): { specKey: string; label: string; cls: ClassName; tables: string[]; default: string | null }[] {
  const targets = targetRelations(target).filter((t) => t.cls === 'event' || t.cls === 'drug')
  const tables = [...new Set(targets.map((t) => t.table))]
  return eventRelations(source).map((rel) => {
    const label = (rel.key ?? '').toLowerCase()
    const byLabel = specEntries(target).find((e) => (e.cls === 'event' || e.cls === 'drug') && (e.key ?? '').toLowerCase() === label)
    const byLabelTable = byLabel ? targets.find((t) => t.specKey === byLabel.specKey)?.table : undefined
    const byClass = rel.cls === 'drug' ? (targets.find((t) => t.cls === 'drug') ?? targets.find((t) => t.table === 'drug_exposure'))?.table : undefined
    return { specKey: rel.specKey, label: rel.key ?? '', cls: rel.cls, tables, default: byLabelTable ?? byClass ?? null }
  })
}

const literal = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? v : `'${escSql(v)}'`)

interface Emitted {
  /** Column → expression, in DDL order. */
  exprs: [string, string][]
  todos: string[]
}

/**
 * Fill a target table's columns: what the inversion names, then OMOP's rules.
 * A nullable column nothing fills is left out; a NOT NULL one gets 0 for a
 * concept id, else NULL and a TODO — the script says what it could not decide.
 */
function fillColumns(
  ddl: ParsedColumn[] | undefined,
  direct: Map<string, string>,
  rules: { typeConceptId: number; concept?: { column: string; id: string; sourceId: string; code: string } },
): Emitted {
  const exprs = new Map(direct)
  const todos: string[] = []
  const columns = ddl ?? [...direct.keys()].map((name) => ({ name, type: '', nullable: true, isPk: false }))
  if (rules.concept) {
    const { column, id, sourceId, code } = rules.concept
    exprs.set(column, id)
    const stem = column.replace(/_concept_id$/, '')
    if (columns.some((c) => c.name === `${stem}_source_concept_id`)) exprs.set(`${stem}_source_concept_id`, sourceId)
    if (columns.some((c) => c.name === `${stem}_source_value`) && !exprs.has(`${stem}_source_value`)) exprs.set(`${stem}_source_value`, code)
  }
  const out: [string, string][] = []
  const dateOf = (name: string) => {
    const dt = exprs.get(`${name}time`)
    return dt ? `CAST(${dt} AS DATE)` : undefined
  }
  for (const col of columns) {
    let expr = exprs.get(col.name)
    if (!expr && col.name.endsWith('_date')) {
      expr = dateOf(col.name)
      // An end the source does not know is the start, by the CDM conventions.
      const start = col.name.includes('_end_') ? dateOf(col.name.replace('_end_', '_start_')) : undefined
      if (!col.nullable && start) expr = expr ? `COALESCE(${expr}, ${start})` : start
    }
    if (!expr && col.name.endsWith('_type_concept_id')) expr = String(rules.typeConceptId)
    if (!expr && !col.nullable) {
      if (col.name.endsWith('_concept_id')) expr = '0'
      else {
        expr = 'NULL'
        todos.push(`${col.name} is NOT NULL and nothing in the source fills it`)
      }
    }
    if (expr) out.push([col.name, expr])
  }
  return { exprs: out, todos }
}

/** The gender concept, from the contract's normalised gender and the target's values. */
function genderExpr(values: NonNullable<InvertedRelation['genderValues']>): string {
  return `CASE s.gender WHEN 'male' THEN ${literal(values.male)} WHEN 'female' THEN ${literal(values.female)} ELSE ${literal(values.unknown ?? '0')} END`
}

/** How the event's concept resolves to an OMOP concept, and the joins it needs. */
function conceptParts(source: SchemaMapping, rel: ClassRelation, mode: EtlConceptMode) {
  const dictRel = rel.dictionary ? classRelations(source).find((r) => r.name === rel.dictionary) : undefined
  const key = dictRel?.key ? sourceConceptKeyExprs(source, dictRel.key, 'c') : null
  const dictJoin = dictRel && key ? `\nLEFT JOIN ${dictRel.name} c ON ${conceptJoinOn(rel, 's', 'c')}` : ''
  const vocabulary = key?.vocabulary ?? `'${escSql(rel.tables[0]?.table ?? rel.key ?? '')}'`
  const code = key?.code ?? 'CAST(s.concept_id AS VARCHAR)'
  if (mode === 'as-is') {
    return { joins: '', id: 's.concept_id', sourceId: has(rel, 'source_concept_id') ? 's.source_concept_id' : '0', code: 'CAST(s.concept_id AS VARCHAR)' }
  }
  if (mode === 'stcm') {
    return {
      joins: `${dictJoin}\nLEFT JOIN ${TARGET}.source_to_concept_map stcm ON stcm.source_vocabulary_id = ${vocabulary} AND stcm.source_code = ${code}`,
      id: 'COALESCE(stcm.target_concept_id, 0)',
      sourceId: 'COALESCE(stcm.source_concept_id, 0)',
      code,
    }
  }
  // One row per 'Maps to': a source concept mapped to two standard concepts
  // gives two OMOP rows, as the CDM conventions ask.
  return {
    joins: `${dictJoin}\nLEFT JOIN ${TARGET}.concept sc ON sc.vocabulary_id = ${vocabulary} AND sc.concept_code = ${code}`
      + `\nLEFT JOIN ${TARGET}.concept_relationship cr ON cr.concept_id_1 = sc.concept_id AND cr.relationship_id = 'Maps to'`,
    id: 'COALESCE(cr.concept_id_2, 0)',
    sourceId: 'COALESCE(sc.concept_id, 0)',
    code,
  }
}

// FNV-1a: stable across front and export, and enough to tell an edit.
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const MARK = '-- linkr-generated: '

/** A generated script: its header ends with the hash of the body below it. */
function stamp(header: string[], body: string): string {
  return `${header.map((l) => `-- ${l}`).join('\n')}\n${MARK}${hash(body)}\n${body}`
}

/**
 * Whether a script is still as generated: `generated` (safe to overwrite),
 * `modified` (someone edited it — ask first), or `foreign` (not generated).
 */
export function generatedScriptState(content: string): 'generated' | 'modified' | 'foreign' {
  const at = content.indexOf(`\n${MARK}`)
  if (at < 0) return 'foreign'
  const rest = content.slice(at + 1 + MARK.length)
  const nl = rest.indexOf('\n')
  if (nl < 0) return 'modified'
  return rest.slice(0, nl).trim() === hash(rest.slice(nl + 1)) ? 'generated' : 'modified'
}

const ORDER: Partial<Record<ClassName, number>> = { patient: 10, visit: 20, visit_detail: 30, note: 40 }
const EVENT_ORDER = 50

/**
 * One script per source relation that has a place in the target: an INSERT per
 * class relation, plus companion INSERTs for the tables the target relation
 * joins (a death table, care sites). The source relation is inlined as a CTE; its
 * bare table names resolve because the ETL run puts the source on the search path.
 */
export function generateOmopEtl(
  source: SchemaMapping,
  target: SchemaMapping,
  ddl: ParsedTable[],
  options: OmopEtlOptions,
): OmopEtlResult {
  const typeConceptId = options.typeConceptId ?? EHR_TYPE_CONCEPT
  const mode = options.conceptMode ?? 'ccr'
  const tables = new Map(ddl.map((t) => [t.bareName.toLowerCase(), t]))
  const targets = targetRelations(target)
  const warnings: OmopEtlWarning[] = []
  const scripts: GeneratedEtlScript[] = []
  const cleared = new Set<string>()
  const names = new Set<string>()

  const ddlOf = (table: string) => {
    const t = tables.get(table.toLowerCase())
    if (!t && !warnings.some((w) => w.kind === 'table-not-in-ddl' && w.table === table)) warnings.push({ kind: 'table-not-in-ddl', table })
    return t?.columns
  }
  const insert = (table: string, e: Emitted, from: string, where: string[], distinct: boolean, orIgnore: boolean) => {
    const lines = e.exprs.map(([col, expr]) => `  ${expr} AS ${col}`)
    const select = `SELECT${distinct ? ' DISTINCT' : ''}\n${lines.join(',\n')}\n${from}${where.length ? `\nWHERE ${where.join('\n  AND ')}` : ''}`
    // OR IGNORE needs a key to conflict on: a companion table filled from two
    // relations (care sites of visits and of unit stays) keeps its first row.
    orIgnore &&= !!tables.get(table.toLowerCase())?.pkColumns.length
    const clear = cleared.has(table) ? '' : `TRUNCATE ${TARGET}.${table};\n\n`
    cleared.add(table)
    const todos = e.todos.map((t) => `-- TODO(etl): ${t}\n`).join('')
    return `${clear}${todos}INSERT${orIgnore ? ' OR IGNORE' : ''} INTO ${TARGET}.${table} (${e.exprs.map(([c]) => c).join(', ')})\n${withClassRelations(select, source)};`
  }
  const push = (rel: ClassRelation, table: string, order: number, body: string[]) => {
    let name = `${order}_${table}.sql`
    if (names.has(name)) name = `${order}_${table}_${(rel.key ?? rel.cls).toLowerCase().replace(/[^a-z0-9]+/g, '_')}.sql`
    names.add(name)
    const header = [
      `Generated by Linkr from the source schema "${options.sourceLabel}": ${rel.specKey} → ${table}.`,
      'Edit freely: regenerating asks before overwriting an edited script.',
    ]
    scripts.push({ name, order, sql: stamp(header, `\n${body.join('\n\n')}\n`), source: rel.specKey, table })
  }

  /** The companion INSERTs of a target relation's joined tables. */
  const companions = (rel: ClassRelation, t: InvertedRelation) =>
    t.joins.flatMap((j) => {
      const direct = new Map<string, string>()
      for (const [col, contract] of j.keys) if (has(rel, contract)) direct.set(col, `s.${contract}`)
      if (direct.size < j.keys.length) return []
      const values = [...j.columns].filter(([contract]) => has(rel, contract))
      if (!values.length) return []
      for (const [contract, col] of values) direct.set(col, `s.${contract}`)
      const e = fillColumns(ddlOf(j.table), direct, { typeConceptId })
      const where = [...j.keys.map(([, c]) => `s.${c} IS NOT NULL`), `(${values.map(([c]) => `s.${c} IS NOT NULL`).join(' OR ')})`]
      return [insert(j.table, e, `FROM ${rel.name} s`, where, true, true)]
    })

  for (const cls of ['patient', 'visit', 'visit_detail', 'note'] as const) {
    const rel = classRelation(source, cls)
    const t = targets.find((x) => x.cls === cls)
    if (!rel) continue
    if (!t) {
      warnings.push({ kind: 'no-target-relation', relation: rel.specKey })
      continue
    }
    const direct = new Map<string, string>()
    for (const [contract, col] of t.columns) {
      if (cls === 'patient' && contract === 'gender_source_value' && t.genderValues && has(rel, 'gender')) direct.set(col, genderExpr(t.genderValues))
      else if (has(rel, contract)) direct.set(col, `s.${contract}`)
    }
    const cols = ddlOf(t.table)
    // A column named like a contract column the inversion left free: the same fact.
    for (const c of cols ?? []) if (!direct.has(c.name) && has(rel, c.name)) direct.set(c.name, `s.${c.name}`)
    if (cls === 'patient' && has(rel, 'birth_year') && t.columns.get('birth_year')) {
      // year_of_birth is NOT NULL in OMOP; the relation already derives it from the date.
      direct.set(t.columns.get('birth_year')!, 's.birth_year')
    }
    const e = fillColumns(cols, direct, { typeConceptId })
    const body = [insert(t.table, e, `FROM ${rel.name} s`, [], false, false), ...companions(rel, t)]
    // OMOP keeps deaths in their own table; a target preset reading it through an
    // expression (not a join) cannot be inverted, so the rule is spelled out.
    if (cls === 'patient' && has(rel, 'death_datetime') && tables.has('death') && !t.joins.some((j) => j.table.toLowerCase() === 'death')) {
      const death = fillColumns(tables.get('death')!.columns, new Map([['person_id', 's.patient_id'], ['death_datetime', 's.death_datetime']]), { typeConceptId })
      body.push(insert('death', death, `FROM ${rel.name} s`, ['s.death_datetime IS NOT NULL'], false, true))
    }
    push(rel, t.table, ORDER[cls]!, body)
  }

  const choices = eventTargetChoices(source, target)
  let order = EVENT_ORDER
  for (const rel of eventRelations(source)) {
    const choice = choices.find((c) => c.specKey === rel.specKey)
    const table = options.eventTargets && rel.specKey in options.eventTargets ? options.eventTargets[rel.specKey] : choice?.default
    if (!table) {
      warnings.push({ kind: 'no-target-table', relation: rel.specKey, label: rel.key ?? rel.specKey })
      continue
    }
    const t = targets.find((x) => (x.cls === 'event' || x.cls === 'drug') && x.table === table)
    const conceptColumn = t?.columns.get('concept_id') ?? `${table.replace(/_(occurrence|exposure)$/, '')}_concept_id`
    const direct = new Map<string, string>()
    for (const [contract, col] of t?.columns ?? []) {
      if (contract === 'concept_id' || contract === 'source_concept_id') continue
      if (has(rel, contract)) direct.set(col, `s.${contract}`)
    }
    const cols = ddlOf(table)
    for (const c of cols ?? []) if (!direct.has(c.name) && has(rel, c.name) && !c.name.endsWith('concept_id')) direct.set(c.name, `s.${c.name}`)
    const pk = cols?.find((c) => c.isPk)
    if (pk && !direct.has(pk.name)) {
      const own = rel.cls === 'drug' && has(rel, 'drug_id') ? 's.drug_id' : 'ROW_NUMBER() OVER ()'
      direct.set(pk.name, own)
    }
    const concept = conceptParts(source, rel, mode)
    const e = fillColumns(cols, direct, { typeConceptId, concept: { column: conceptColumn, ...concept } })
    if (pk && direct.get(pk.name) === 'ROW_NUMBER() OVER ()') e.todos.unshift(`${pk.name} is numbered per run; give the source relation an id for stable keys`)
    push(rel, table, order++, [insert(table, e, `FROM ${rel.name} s${concept.joins}`, [], false, false)])
  }

  return { scripts, warnings }
}
