import type { DrugSpec, EventSpec, FieldSpec, PatientSpec, RelationSpec, RelationTable, SchemaMapping } from '@/types/schema-mapping'
import { escSql, isSafeIdentifier } from '@/lib/format-helpers'
import { protectedRegions, splitSqlStatements } from '@/lib/duckdb/sql-tokenizer'
import { CLASS_CONTRACTS, RELATION_PREFIX, type ClassName } from './contracts'
import { specTables } from './spec'

/**
 * One class relation: a SELECT honouring its class contract, and the name
 * queries reach it by. The only place mapping fields turn into SQL — every
 * consumer reads the contract columns (plan §6, "What this centralises").
 */
export interface ClassRelation {
  name: string
  cls: ClassName
  /** Concept dictionary key, or event / drug label. */
  key?: string
  /** Where the relation is defined in the mapping: `visit`, `events.<label>`… */
  specKey: string
  /** The effective SQL is the hand-written `customSql`. */
  custom: boolean
  /** What the generator had to drop: a field naming an unknown alias, a bad
   *  identifier, custom SQL that is not a single statement. */
  problems: string[]
  /** The source tables a visual relation reads (`from` first); empty for SQL. */
  tables: RelationTable[]
  sql: string
  /** Contract columns that carry data; the others are emitted as NULL. */
  mapped: ReadonlySet<string>
  /** Event / drug: relation name of its concept dictionary; null when it names
   *  its concepts inline (`conceptDictionaryKey: 'none'`). */
  dictionary?: string | null
  /** Event: joins its dictionary on (concept_terminology, concept_code) rather
   *  than concept_id — a thesaurus where a code is only unique per terminology. */
  compositeConceptKey?: boolean
  /** Concept: `extra_<alias>` columns, keyed by the mapping's alias. */
  extras?: Readonly<Record<string, string>>
}

const cache = new WeakMap<SchemaMapping, ClassRelation[]>()

/** Every relation the mapping defines. Memoised per mapping object. */
export function classRelations(mapping: SchemaMapping): ClassRelation[] {
  let rels = cache.get(mapping)
  if (!rels) {
    rels = buildRelations(mapping)
    cache.set(mapping, rels)
  }
  return rels
}

export function classRelation(mapping: SchemaMapping, cls: 'patient' | 'visit' | 'visit_detail' | 'note'): ClassRelation | undefined {
  return classRelations(mapping).find((r) => r.cls === cls)
}

/** Event and drug relations: a drug relation carries the event columns, so
 *  everything reading events (concept counts, criteria, charts) reads drugs too. */
export function eventRelations(mapping: SchemaMapping): ClassRelation[] {
  return classRelations(mapping).filter((r) => r.cls === 'event' || r.cls === 'drug')
}

export function drugRelations(mapping: SchemaMapping): ClassRelation[] {
  return classRelations(mapping).filter((r) => r.cls === 'drug')
}

export function conceptRelations(mapping: SchemaMapping): ClassRelation[] {
  return classRelations(mapping).filter((r) => r.cls === 'concept')
}

/** The event or drug relation the mapping labels `label` (labels are unique
 *  across both lists). */
export function eventRelation(mapping: SchemaMapping, label: string): ClassRelation | undefined {
  return eventRelations(mapping).find((r) => r.key === label)
}

export function conceptRelation(mapping: SchemaMapping, key: string): ClassRelation | undefined {
  return conceptRelations(mapping).find((r) => r.key === key)
}

export function drugRelation(mapping: SchemaMapping, label: string): ClassRelation | undefined {
  return drugRelations(mapping).find((r) => r.key === label)
}

/** The concept dictionary an event relation joins, if any. */
export function dictionaryOf(mapping: SchemaMapping, event: ClassRelation): ClassRelation | undefined {
  if (!event.dictionary) return undefined
  return classRelations(mapping).find((r) => r.name === event.dictionary)
}

/** ON clause joining an event relation (alias `e`) to its dictionary (alias `c`). */
export function conceptJoinOn(event: ClassRelation, e: string, c: string): string {
  return event.compositeConceptKey
    ? `${e}.concept_terminology = ${c}.concept_terminology AND ${e}.concept_code = ${c}.concept_code`
    : `${e}.concept_id = ${c}.concept_id`
}

/** Is this contract column filled by the relation? */
export function has(rel: ClassRelation | undefined, column: string): boolean {
  return !!rel && rel.mapped.has(column)
}


// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** String literals, comments and dollar blocks blanked out (same length);
 *  quoted identifiers kept, since `a."col"` is a column reference. */
export function blankSqlLiterals(sql: string): string {
  let out = sql
  for (const r of protectedRegions(sql)) {
    if (sql[r.start] === '"') continue
    out = out.slice(0, r.start) + ' '.repeat(r.end - r.start) + out.slice(r.end)
  }
  return out
}

// `alias.column` or `alias."column"` inside an expression.
const ALIAS_COLUMN = /(?<![\w."])([A-Za-z_]\w*)\s*\.\s*(?:"((?:[^"]|"")+)"|([A-Za-z_]\w*))/g

const REF = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/

const isColumnName = (name: string) => isSafeIdentifier(name) && !name.includes('.')

type Exprs = Record<string, string | null | undefined>

/**
 * Compiles one visual relation: resolves `alias.column` references against
 * `from` + `joins`, and records every column it names so the FROM can pad it.
 *
 * A mapping naming a column its table lacks — a stale preset, a typo — would
 * make the relation fail for every query that touches it, not only the ones
 * reading that column. An empty UNION BY NAME branch pads each named column with
 * NULLs where it is missing (matched case-insensitively). Measured free under a
 * per-patient filter or a GROUP BY; only a bare whole-table COUNT(*) loses its
 * metadata shortcut (plan §6).
 */
class Builder {
  private aliases = new Map<string, RelationTable>()
  private used = new Map<string, Map<string, string>>()
  readonly problems: string[] = []

  private readable: boolean

  /** `readable`: the SQL a person edits, without the padding. */
  constructor(spec: RelationSpec, readable = false) {
    this.readable = readable
    for (const t of [spec.from, ...(spec.joins ?? [])]) {
      if (!t?.table) continue
      if (!isColumnName(t.alias) || !isSafeIdentifier(t.table) || (t.schema && !isSafeIdentifier(t.schema))) {
        this.problems.push(`invalid table or alias: ${t.alias}`)
        continue
      }
      this.aliases.set(t.alias.toLowerCase(), t)
    }
  }

  private record(alias: string, column: string) {
    const key = alias.toLowerCase()
    let cols = this.used.get(key)
    if (!cols) this.used.set(key, (cols = new Map()))
    cols.set(column.toLowerCase(), column)
  }

  /** `alias."column"` for a reference, or null (with a problem) when it does not resolve. */
  ref(text: string): string | null {
    const m = REF.exec(text.trim())
    const table = m && this.aliases.get(m[1].toLowerCase())
    if (!m || !table) {
      this.problems.push(`unknown column reference: ${text}`)
      return null
    }
    this.record(table.alias, m[2])
    return `${table.alias}."${m[2]}"`
  }

  /** A free SQL expression, its column references recorded. */
  expr(sql: string): string {
    const text = sql.trim()
    for (const m of blankSqlLiterals(text).matchAll(ALIAS_COLUMN)) {
      const table = this.aliases.get(m[1].toLowerCase())
      if (table) this.record(table.alias, m[2]?.replace(/""/g, '"') ?? m[3])
    }
    return text
  }

  field(f: FieldSpec | undefined): string | null {
    if (f === undefined || f === null) return null
    if (typeof f === 'string') return f.trim() ? this.ref(f) : null
    if ('expr' in f) return f.expr?.trim() ? `(${this.expr(f.expr)})` : null
    if ('value' in f) {
      const v = f.value
      if (v === null || v === undefined) return null
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
      return `'${escSql(String(v))}'`
    }
    return null
  }

  /** The table under its alias, padded with every column the relation named. */
  table(t: RelationTable): string {
    const base = t.schema ? `"${t.schema}"."${t.table}"` : `"${t.table}"`
    const cols = [...(this.used.get(t.alias.toLowerCase())?.values() ?? [])]
    if (cols.length === 0 || this.readable) return `${base} ${t.alias}`
    const pads = cols.map((col) => `NULL AS "${col.replace(/"/g, '""')}"`).join(', ')
    return `(SELECT * FROM ${base} UNION ALL BY NAME SELECT ${pads} WHERE false) ${t.alias}`
  }

  has(alias: string | undefined): boolean {
    return !!alias && this.aliases.has(alias.toLowerCase())
  }
}

interface Compiled {
  sql: string
  mapped: Set<string>
  custom: boolean
  problems: string[]
  extras: Record<string, string>
}

/** Class-specific columns derived from the others (visual form only). */
type Derive = (exprs: Exprs, b: Builder) => void

const EXTRA_KEY = /^extra_[A-Za-z0-9_]+$/

function selectList(cls: ClassName, exprs: Exprs, extraKeys: string[], mappedOnly = false, only?: ReadonlySet<string>): { lines: string[]; mapped: Set<string> } {
  const mapped = new Set<string>()
  const lines = CLASS_CONTRACTS[cls].filter(({ name }) => !only || only.has(name)).flatMap(({ name }) => {
    const expr = exprs[name]
    if (expr) mapped.add(name)
    return expr || !mappedOnly ? [`  ${expr ?? 'NULL'} AS ${name}`] : []
  })
  for (const key of extraKeys) {
    const expr = exprs[key]
    if (expr) mapped.add(key)
    lines.push(`  ${expr ?? 'NULL'} AS "${key}"`)
  }
  return { lines, mapped }
}

/** A visual relation's column expressions, over its tables' aliases. */
function visualExprs(cls: ClassName, spec: RelationSpec, derive: Derive | undefined, readable: boolean) {
  if (!spec.from?.table) return null
  const b = new Builder(spec, readable)
  if (!b.has(spec.from.alias)) return null
  const contract = new Set(CLASS_CONTRACTS[cls].map((c) => c.name))
  const exprs: Exprs = {}
  const extraKeys: string[] = []
  for (const [key, f] of Object.entries(spec.fields ?? {})) {
    const isExtra = cls === 'concept' && EXTRA_KEY.test(key)
    if (!contract.has(key) && !isExtra) {
      b.problems.push(`not a ${cls} column: ${key}`)
      continue
    }
    if (isExtra) extraKeys.push(key)
    exprs[key] = b.field(f)
  }
  derive?.(exprs, b)
  return { b, exprs, extraKeys }
}

/** `readable`: no padding (the SQL a person edits). `mappedOnly`: leave out the
 *  contract columns nothing maps — what the relation editor starts from. */
function compileVisual(
  cls: ClassName, spec: RelationSpec, derive?: Derive, readable = false, mappedOnly = readable, only?: ReadonlySet<string>,
): Compiled | null {
  const parts = visualExprs(cls, spec, derive, readable)
  if (!parts || !spec.from) return null
  const { b, exprs, extraKeys } = parts

  const joins = (spec.joins ?? []).filter((j) => b.has(j.alias)).map((j) => {
    const on = (j.on ?? [])
      .map(([l, r]) => {
        const left = b.ref(l)
        const right = b.ref(r)
        return left && right ? `${left} = ${right}` : null
      })
      .filter((x): x is string => !!x)
    return { j, on: on.length ? on.join(' AND ') : 'false' }
  })
  const where = spec.where?.trim() ? b.expr(spec.where) : null

  const { lines, mapped } = selectList(cls, exprs, extraKeys, mappedOnly, only)
  const from = [
    `FROM ${b.table(spec.from)}`,
    ...joins.map(({ j, on }) => `${j.type === 'inner' ? 'INNER' : 'LEFT'} JOIN ${b.table(j)} ON ${on}`),
    ...(where ? [`WHERE (${where})`] : []),
  ]
  const extras = Object.fromEntries(extraKeys.map((k) => [k.slice('extra_'.length), k]))
  return { sql: `SELECT\n${lines.join(',\n')}\n${from.join('\n')}`, mapped, custom: false, problems: b.problems, extras }
}

/**
 * Hand-written SQL, projected onto the contract: a column it does not return
 * reads NULL, one it returns beyond the contract is dropped, so every consumer
 * binds whatever the SQL does inside.
 */
function compileCustom(cls: ClassName, spec: RelationSpec, fixed: Exprs = {}, only?: ReadonlySet<string>): Compiled {
  const problems: string[] = []
  const contract = CLASS_CONTRACTS[cls].map((c) => c.name)
  const declared = spec.sqlColumns ?? [
    ...Object.keys(spec.fields ?? {}),
    ...CLASS_CONTRACTS[cls].filter((c) => c.required).map((c) => c.name),
  ]
  const extraKeys = cls === 'concept' ? [...new Set(declared.filter((k) => EXTRA_KEY.test(k)))] : []
  const allColumns = [...contract, ...extraKeys]
  // `only` narrows what is selected; every column is still padded, since a
  // fallback value can read one that is not selected.
  const columns = allColumns.filter((c) => !only || only.has(c))
  const mapped = new Set(declared.filter((k) => allColumns.includes(k)))
  // A fixed value carries data when it is a literal, or when one of the columns
  // it falls back on does.
  for (const [k, expr] of Object.entries(fixed)) {
    if (!expr) continue
    const refs = [...expr.matchAll(/_c\."(\w+)"/g)].map((m) => m[1])
    if (!refs.length || refs.some((r) => mapped.has(r))) mapped.add(k)
  }

  let body = (spec.customSql ?? '').trim().replace(/;\s*$/, '')
  if (splitSqlStatements(body).length !== 1 || !/^\s*(\(|select\b|with\b|from\b|values\b)/i.test(blankSqlLiterals(body))) {
    problems.push('custom SQL must be a single SELECT statement')
    body = `SELECT error('${escSql(`Custom SQL of the ${cls} relation must be a single SELECT statement`)}') AS _linkr_error`
    const nulls = columns.map((c) => `  NULL AS "${c}"`).join(',\n')
    return { sql: `SELECT\n${nulls}\nFROM (${body}) _c\nWHERE _c._linkr_error IS NULL`, mapped: new Set(), custom: true, problems, extras: {} }
  }
  const pads = allColumns.map((c) => `NULL AS "${c}"`).join(', ')
  const lines = columns.map((c) => {
    const col = `_c."${c}"`
    return `  ${fixed[c] ? `COALESCE(${col}, ${fixed[c]})` : col} AS ${EXTRA_KEY.test(c) ? `"${c}"` : c}`
  })
  const sql = `SELECT\n${lines.join(',\n')}\nFROM (SELECT * FROM (\n${body}\n) _src UNION ALL BY NAME SELECT ${pads} WHERE false) _c`
  const extras = Object.fromEntries(extraKeys.map((k) => [k.slice('extra_'.length), k]))
  return { sql, mapped, custom: true, problems, extras }
}

function compile(cls: ClassName, spec: RelationSpec, derive?: Derive, fixed?: Exprs): Compiled | null {
  return spec.customSql?.trim() ? compileCustom(cls, spec, fixed) : compileVisual(cls, spec, derive)
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table'
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

const derivePatient =
  (spec: PatientSpec): Derive =>
  (exprs) => {
    // Birth date first: in OMOP `year_of_birth` is NOT NULL but `birth_datetime` is
    // frequently empty, so the precise column alone leaves most ages NULL.
    if (exprs.birth_date) {
      const fromDate = `DATE_PART('year', ${exprs.birth_date}::TIMESTAMP)`
      exprs.birth_year = exprs.birth_year ? `COALESCE(${fromDate}, ${exprs.birth_year})` : fromDate
    }
    const gv = spec.genderValues
    const raw = exprs.gender_source_value
    if (!exprs.gender && raw && gv) {
      exprs.gender = `CASE WHEN ${raw} IS NULL THEN NULL WHEN CAST(${raw} AS VARCHAR) = '${escSql(gv.male)}' THEN 'male' WHEN CAST(${raw} AS VARCHAR) = '${escSql(gv.female)}' THEN 'female' ELSE 'unknown' END`
    }
  }

const deriveEvent =
  (spec: EventSpec): Derive =>
  (exprs) => {
    // A relation naming its concepts inline: the concept column is its own label.
    if (spec.conceptDictionaryKey === 'none' && !exprs.concept_name && exprs.concept_id) {
      exprs.concept_name = `CAST(${exprs.concept_id} AS VARCHAR)`
    }
  }

const drugKindLiteral = (spec: DrugSpec) => `'${spec.drugKind === 'prescription' ? 'prescription' : 'administration'}'`

/** The event columns of a drug relation, from its dose columns: what a
 *  consumer reading any event relation (a value criterion, a chart) sees. */
const deriveDrug =
  (spec: DrugSpec): Derive =>
  (exprs, b) => {
    deriveEvent(spec)(exprs, b)
    exprs.drug_kind ??= drugKindLiteral(spec)
    const amounts = [exprs.amount_value, exprs.quantity].filter((x): x is string => !!x)
    if (!exprs.value_number && amounts.length) exprs.value_number = amounts.length > 1 ? `COALESCE(${amounts.join(', ')})` : amounts[0]
    if (!exprs.unit && exprs.amount_unit) exprs.unit = exprs.amount_unit
    if (!exprs.value_string && exprs.dose_source_value) exprs.value_string = exprs.dose_source_value
  }

/** The same fallbacks for hand-written SQL, over its padded `_c` projection. */
const drugFixed = (spec: DrugSpec): Exprs => ({
  drug_kind: drugKindLiteral(spec),
  value_number: 'COALESCE(_c."amount_value", _c."quantity")',
  unit: '_c."amount_unit"',
  value_string: '_c."dose_source_value"',
})

function buildRelations(mapping: SchemaMapping): ClassRelation[] {
  const rels: ClassRelation[] = []
  const taken = new Set<string>()
  const push = (base: Omit<ClassRelation, 'sql' | 'mapped' | 'custom' | 'problems' | 'tables'>, spec: RelationSpec, compiled: Compiled | null) => {
    if (!compiled) return
    taken.add(base.name)
    rels.push({ ...base, sql: compiled.sql, mapped: compiled.mapped, custom: compiled.custom, problems: compiled.problems, tables: specTables(spec) })
  }

  if (mapping.patient) {
    const spec = mapping.patient
    push({ name: `${RELATION_PREFIX}patient`, cls: 'patient', specKey: 'patient' }, spec, compile('patient', spec, derivePatient(spec)))
  }
  const singletons = [
    ['visit', 'visit', mapping.visit],
    ['visit_detail', 'visitDetail', mapping.visitDetail],
    ['note', 'note', mapping.note],
  ] as const
  for (const [cls, specKey, spec] of singletons) {
    if (spec) push({ name: `${RELATION_PREFIX}${cls}`, cls, specKey }, spec, compile(cls, spec))
  }

  const dicts = new Map<string, { name: string; mapped: ReadonlySet<string> }>()
  for (const spec of mapping.concepts ?? []) {
    const name = uniqueName(`${RELATION_PREFIX}concept_${slug(spec.key)}`, taken)
    const compiled = compile('concept', spec)
    if (!compiled) continue
    dicts.set(spec.key, { name, mapped: compiled.mapped })
    rels.push({
      name, cls: 'concept', key: spec.key, specKey: `concepts.${spec.key}`,
      sql: compiled.sql, mapped: compiled.mapped, custom: compiled.custom, problems: compiled.problems, extras: compiled.extras,
      tables: specTables(spec),
    })
  }

  const defaultDict = mapping.concepts?.[0]?.key
  const addEvent = (cls: 'event' | 'drug', spec: EventSpec, derive: Derive, fixed?: Exprs) => {
    const compiled = compile(cls, spec, derive, fixed)
    if (!compiled) return
    const name = uniqueName(`${RELATION_PREFIX}${cls}_${slug(spec.label)}`, taken)
    const dictKey = spec.conceptDictionaryKey === 'none' ? null : (spec.conceptDictionaryKey ?? defaultDict)
    const dict = dictKey ? dicts.get(dictKey) : undefined
    // null only for the explicit inline opt-out; an id-keyed relation with no
    // dictionary loaded is still filterable by id, it just has nothing to join.
    const dictionary = dictKey === null ? null : dict?.name
    const composite = !!dict && ['concept_terminology', 'concept_code'].every((c) => compiled.mapped.has(c) && dict.mapped.has(c))
    rels.push({
      name, cls, key: spec.label, specKey: `${cls}s.${spec.label}`,
      sql: composite ? resolveConceptId(compiled.sql, dict.name) : compiled.sql,
      mapped: compiled.mapped, custom: compiled.custom, problems: compiled.problems,
      dictionary, compositeConceptKey: composite, tables: specTables(spec),
    })
  }
  for (const spec of mapping.events ?? []) addEvent('event', spec, deriveEvent(spec))
  for (const spec of mapping.drugs ?? []) addEvent('drug', spec, deriveDrug(spec), drugFixed(spec))
  return rels
}

/**
 * An event keyed by (terminology, code) has no dictionary id of its own — what
 * the mapping gives as its `concept_id` is a code. Every consumer filters,
 * counts and joins on `concept_id` as the dictionary's id, so the relation looks
 * it up once here. A dictionary may repeat a (terminology, code) pair, so it is
 * reduced to one id per pair — the smallest — before the join, which then cannot
 * multiply rows. A code the dictionary lacks reads a NULL concept_id.
 */
function resolveConceptId(eventSql: string, dictName: string): string {
  return `SELECT _ev.* REPLACE (_dict.concept_id AS concept_id)
FROM (
${eventSql}
) _ev
LEFT JOIN (
  SELECT concept_terminology, concept_code, min(concept_id) AS concept_id
  FROM ${dictName}
  GROUP BY concept_terminology, concept_code
) _dict ON _ev.concept_terminology = _dict.concept_terminology AND _ev.concept_code = _dict.concept_code`
}

/** The relation's class, derived columns and fixed values, by where it lives. */
function compileParts(mapping: SchemaMapping, specKey: string): { cls: ClassName; spec: RelationSpec; derive?: Derive; fixed?: Exprs } | null {
  if (specKey === 'patient' && mapping.patient) return { cls: 'patient', spec: mapping.patient, derive: derivePatient(mapping.patient) }
  if (specKey === 'visit' && mapping.visit) return { cls: 'visit', spec: mapping.visit }
  if (specKey === 'visitDetail' && mapping.visitDetail) return { cls: 'visit_detail', spec: mapping.visitDetail }
  if (specKey === 'note' && mapping.note) return { cls: 'note', spec: mapping.note }
  const [list, ...rest] = specKey.split('.')
  const key = rest.join('.')
  if (list === 'concepts') {
    const spec = mapping.concepts?.find((c) => c.key === key)
    return spec ? { cls: 'concept', spec } : null
  }
  if (list === 'events' || list === 'drugs') {
    const spec = (list === 'events' ? mapping.events : mapping.drugs)?.find((e) => e.label === key)
    if (!spec) return null
    return list === 'events'
      ? { cls: 'event', spec, derive: deriveEvent(spec) }
      : { cls: 'drug', spec, derive: deriveDrug(spec as DrugSpec), fixed: drugFixed(spec as DrugSpec) }
  }
  return null
}

/**
 * The SQL of a relation's visual form as a person would write it: mapped
 * columns only, no padding, `{{parameters}}` left in place. What the SQL editor
 * starts from; saved as `customSql`, it is projected onto the contract like any
 * hand-written SQL.
 */
export function readableRelationSql(mapping: SchemaMapping, specKey: string): string | null {
  const parts = compileParts(mapping, specKey)
  if (!parts) return null
  return compileVisual(parts.cls, { ...parts.spec, customSql: null }, parts.derive, true)?.sql ?? null
}

/** The SQL the visual form generates as the relation runs it — compared before
 *  and after a form edit to know whether a hand edit would be overwritten. */
export function generatedRelationSql(mapping: SchemaMapping, specKey: string): string | null {
  const parts = compileParts(mapping, specKey)
  if (!parts) return null
  return compileVisual(parts.cls, { ...parts.spec, customSql: null }, parts.derive)?.sql ?? null
}

/**
 * How a relation reads written straight on its source tables, for a query shown
 * in the database's own terms (`lib/schema-classes/native-sql.ts`). `used`: the
 * contract columns the query reads from it.
 *  - `table`: one table and nothing else — every contract column is an
 *    expression over the table's alias, to substitute where the column is read;
 *  - `subquery`: anything more (joins, a filter, hand-written SQL), to put where
 *    the relation stands in a FROM: the hand-written SQL itself when it returns
 *    every used column as the relation does, else a SELECT of the used columns.
 */
export type InlineRelation =
  | { kind: 'table'; table: RelationTable; columns: Record<string, string | null> }
  | { kind: 'subquery'; sql: string }

export function inlineRelation(mapping: SchemaMapping, name: string, used: ReadonlySet<string>): InlineRelation | null {
  const rel = classRelations(mapping).find((r) => r.name === name)
  const parts = rel && compileParts(mapping, rel.specKey)
  if (!rel || !parts) return null
  const { cls, spec, derive, fixed } = parts
  if (rel.compositeConceptKey && used.has('concept_id')) return inlineCompositeEvent(mapping, rel, parts, used)
  if (!rel.custom && spec.from && !spec.joins?.length && !spec.where?.trim()) {
    const visual = visualExprs(cls, { ...spec, customSql: null }, derive, true)
    if (visual) {
      const columns: Record<string, string | null> = {}
      for (const { name: column } of CLASS_CONTRACTS[cls]) columns[column] = visual.exprs[column] ?? null
      return { kind: 'table', table: spec.from, columns }
    }
  }
  if (rel.custom) {
    // Returned as the relation returns them: declared, with no fallback value
    // the projection would put in place of a NULL.
    const body = (spec.customSql ?? '').trim().replace(/;\s*$/, '')
    const declared = new Set(spec.sqlColumns ?? [])
    if ([...used].every((c) => declared.has(c) && !fixed?.[c])) return { kind: 'subquery', sql: body }
    return { kind: 'subquery', sql: compileCustom(cls, spec, fixed, used).sql }
  }
  const sql = compileVisual(cls, { ...spec, customSql: null }, derive, true, false, used)?.sql
  return sql ? { kind: 'subquery', sql } : null
}

const CONCEPT_KEY = new Set(['concept_id', 'concept_terminology', 'concept_code'])

/** An event keyed by (terminology, code) whose `concept_id` is read: its
 *  dictionary lookup (`resolveConceptId`) written on the source tables too. */
function inlineCompositeEvent(
  mapping: SchemaMapping, rel: ClassRelation, parts: NonNullable<ReturnType<typeof compileParts>>, used: ReadonlySet<string>,
): InlineRelation | null {
  const dict = dictionaryOf(mapping, rel)
  const dictParts = dict && compileParts(mapping, dict.specKey)
  if (!dictParts) return null
  const subquery = (p: NonNullable<ReturnType<typeof compileParts>>, only: ReadonlySet<string>) => p.spec.customSql?.trim()
    ? compileCustom(p.cls, p.spec, p.fixed, only).sql
    : compileVisual(p.cls, { ...p.spec, customSql: null }, p.derive, true, false, only)?.sql
  const eventSql = subquery(parts, new Set([...used, 'concept_terminology', 'concept_code']))
  const dictSql = subquery(dictParts, CONCEPT_KEY)
  return eventSql && dictSql ? { kind: 'subquery', sql: resolveConceptId(eventSql, `(\n${dictSql}\n)`) } : null
}
