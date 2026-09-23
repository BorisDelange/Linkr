/**
 * Pure cohort helpers for the live server: turn the loose criteria a model writes
 * into the exact tree the app stores, and describe trees and schema mappings in
 * words a model can act on. No I/O here — the server does the calls.
 */
import { randomUUID } from 'node:crypto'
import { getNodeLabel } from '@/lib/duckdb/cohort-query'
import type {
  CohortLevel, CriteriaGroupNode, CriteriaTreeNode, CriteriaType, SchemaMapping,
} from '@/types'

export const COHORT_LEVELS: CohortLevel[] = ['patient', 'visit', 'visit_detail', 'event']
const CRITERIA_TYPES: CriteriaType[] = [
  'age', 'sex', 'death', 'period', 'duration', 'care_site', 'concept', 'text',
]
const VALUE_OPERATORS = ['>', '>=', '=', '<=', '<', '!=', 'between']
const COUNT_OPERATORS = ['>=', '>', '=', '<=', '<']

/**
 * The criteria format, as the model reads it in tool descriptions. Kept next to
 * the normaliser so the two cannot drift apart.
 */
export const CRITERIA_FORMAT = `Criteria are a tree. A node is either a criterion or a group.

Criterion: {"type": "<type>", "config": {...}, "operator": "AND"|"OR", "exclude": false}
Group:     {"children": [<nodes>], "operator": "AND"|"OR", "exclude": false, "label": "optional"}

"operator" links a node to its PREVIOUS sibling (ignored on the first; default AND).
"exclude": true negates the node (NOT). Ids are assigned for you.
Pass either the root group or just the array of top-level nodes.

Criterion types and their config:
- age:       {"ageReference": "admission"|"current", "min"?: n, "max"?: n, "ageUnit"?: "years"|"months"|"days"}
- sex:       {"values": ["<value from the mapping's genderValues>", ...]}
- death:     {"isDead": true|false, "deathReference"?: "visit"|"visit_detail"|"any"}
- period:    {"startDate"?: "YYYY-MM-DD", "endDate"?: "YYYY-MM-DD"}  (visit start date within)
- duration:  {"durationLevel": "visit"|"visit_detail", "durationUnit"?: "hours"|"days"|"months", "minDays"?: n, "maxDays"?: n}
             (minDays/maxDays are in durationUnit, despite the name)
- care_site: {"careSiteLevel": "visit"|"visit_detail", "values": ["<unit name or id>", ...]}
- concept:   {"eventTableLabel": "<key of the mapping's eventTables>", "conceptIds": [int, ...],
              "valueFilters"?: [{"operator": ">"|">="|"="|"<="|"<"|"!="|"between", "value": n, "value2"?: n}],
              "occurrenceCount"?: {"operator": ">="|">"|"="|"<="|"<", "count": n}}
             conceptIds come from search_concepts; names are filled in for you.
- text:      {"searches": [{"field": "title"|"text", "terms": ["..."], "mode"?: "contains"|"word"|"regex",
              "anyTerm"?: true, "exclude"?: false}], "label"?: "..."}  (needs a note table)`

export interface NormalizeResult {
  tree: CriteriaGroupNode
  errors: string[]
  warnings: string[]
}

type Loose = Record<string, unknown>

const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Smaller models often pass the criteria as a JSON-encoded string rather than
 *  as JSON: accept it, since the schema cannot type a field that takes both an
 *  object and an array. */
function parseIfJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `a string that is not valid JSON: ${value.slice(0, 80)}`
  return value === null ? 'null' : typeof value
}

/**
 * Normalise model-written criteria into a stored tree, collecting every problem
 * rather than stopping at the first, so one round trip fixes them all.
 */
export function normalizeCriteria(raw: unknown, mapping: SchemaMapping): NormalizeResult {
  const errors: string[] = []
  const warnings: string[] = []
  const input = parseIfJson(raw)
  const rootInput: Loose = Array.isArray(input) ? { children: input } : isObject(input) ? input : { children: [] }
  if (!Array.isArray(input) && !isObject(input)) {
    errors.push(`criteria must be a group object or an array of nodes (JSON), got ${describeValue(input)}.`)
  }

  const group = (raw: Loose, path: string): CriteriaGroupNode => ({
    kind: 'group',
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    operator: raw.operator === 'OR' ? 'OR' : 'AND',
    exclude: raw.exclude === true,
    enabled: raw.enabled !== false,
    children: Array.isArray(raw.children)
      ? raw.children.map((c, i) => node(c, `${path}.children[${i}]`)).filter((n): n is CriteriaTreeNode => n !== null)
      : [],
  })

  const node = (raw: unknown, path: string): CriteriaTreeNode | null => {
    if (!isObject(raw)) {
      errors.push(`${path}: not an object.`)
      return null
    }
    if (raw.kind === 'group' || Array.isArray(raw.children)) return group(raw, path)
    const type = raw.type as CriteriaType
    if (!CRITERIA_TYPES.includes(type)) {
      errors.push(`${path}: unknown criterion type ${JSON.stringify(raw.type)} (one of ${CRITERIA_TYPES.join(', ')}).`)
      return null
    }
    const config = isObject(raw.config) ? { ...raw.config } : {}
    checkConfig(type, config, mapping, path, errors, warnings)
    if (raw.operator !== undefined && raw.operator !== 'AND' && raw.operator !== 'OR') {
      errors.push(`${path}.operator: must be "AND" or "OR".`)
    }
    return {
      kind: 'criterion',
      id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
      type,
      config: config as never,
      operator: raw.operator === 'OR' ? 'OR' : 'AND',
      exclude: raw.exclude === true,
      enabled: raw.enabled !== false,
    }
  }

  return { tree: group(rootInput, 'criteria'), errors, warnings }
}

function checkConfig(
  type: CriteriaType, c: Loose, mapping: SchemaMapping, path: string, errors: string[], warnings: string[],
): void {
  const at = `${path}.config`
  const optionalNumbers = (...keys: string[]) => {
    for (const k of keys) if (c[k] !== undefined && !isNum(c[k])) errors.push(`${at}.${k}: must be a number.`)
  }
  const oneOf = (key: string, allowed: string[], required: boolean) => {
    if (c[key] === undefined) {
      if (required) errors.push(`${at}.${key}: required, one of ${allowed.join(', ')}.`)
      return
    }
    if (!allowed.includes(c[key] as string)) errors.push(`${at}.${key}: must be one of ${allowed.join(', ')}.`)
  }
  const stringList = (key: string) => {
    if (!Array.isArray(c[key]) || (c[key] as unknown[]).some((v) => typeof v !== 'string' && !isNum(v))) {
      errors.push(`${at}.${key}: must be an array of values.`)
      return
    }
    c[key] = (c[key] as unknown[]).map(String)
  }
  const needsVisitDetail = (key: string) => {
    if (c[key] === 'visit_detail' && !mapping.visitDetailTable) {
      errors.push(`${at}.${key}: this database's mapping has no visit-detail (unit stay) table.`)
    }
  }

  switch (type) {
    case 'age': {
      oneOf('ageReference', ['admission', 'current'], true)
      oneOf('ageUnit', ['years', 'months', 'days'], false)
      optionalNumbers('min', 'max')
      if (c.min === undefined && c.max === undefined) errors.push(`${at}: give min and/or max.`)
      const pt = mapping.patientTable
      if (!pt?.birthDateColumn && !pt?.birthYearColumn) {
        warnings.push(
          `${path}: the schema mapping has no birth date or birth year column, so this age criterion `
          + 'is IGNORED (it matches everyone). Express age with run_sql / custom SQL on the real columns instead.',
        )
      } else if ((c.ageUnit ?? 'years') !== 'years' && !pt.birthDateColumn) {
        warnings.push(`${path}: ages in ${String(c.ageUnit)} need a birth date column; this criterion will match nobody.`)
      }
      break
    }
    case 'sex': {
      stringList('values')
      const gv = mapping.genderValues
      const known = gv ? [gv.male, gv.female, gv.unknown].filter(Boolean) as string[] : []
      if (Array.isArray(c.values) && known.length) {
        const bad = (c.values as string[]).filter((v) => !known.includes(v))
        if (bad.length) errors.push(`${at}.values: ${bad.join(', ')} not in genderValues (${known.join(', ')}).`)
      }
      break
    }
    case 'death':
      if (typeof c.isDead !== 'boolean') errors.push(`${at}.isDead: required, true or false.`)
      oneOf('deathReference', ['visit', 'visit_detail', 'any'], false)
      needsVisitDetail('deathReference')
      break
    case 'period':
      for (const k of ['startDate', 'endDate']) {
        if (c[k] !== undefined && !(typeof c[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(c[k] as string))) {
          errors.push(`${at}.${k}: must be a date YYYY-MM-DD.`)
        }
      }
      break
    case 'duration':
      oneOf('durationLevel', ['visit', 'visit_detail'], true)
      oneOf('durationUnit', ['hours', 'days', 'months'], false)
      optionalNumbers('minDays', 'maxDays')
      needsVisitDetail('durationLevel')
      if (c.minDays === undefined && c.maxDays === undefined) errors.push(`${at}: give minDays and/or maxDays.`)
      break
    case 'care_site':
      oneOf('careSiteLevel', ['visit', 'visit_detail'], true)
      needsVisitDetail('careSiteLevel')
      stringList('values')
      break
    case 'concept': {
      const tables = Object.keys(mapping.eventTables ?? {})
      const label = c.eventTableLabel
      const exact = tables.find((t) => t === label)
        ?? tables.find((t) => typeof label === 'string' && t.toLowerCase() === label.toLowerCase())
      if (!exact) errors.push(`${at}.eventTableLabel: ${JSON.stringify(label)} is not an event table (${tables.join(', ')}).`)
      else c.eventTableLabel = exact
      const ids = c.conceptIds
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((v) => !Number.isInteger(Number(v)))) {
        errors.push(`${at}.conceptIds: a non-empty array of integer concept ids.`)
      } else {
        c.conceptIds = ids.map(Number)
      }
      if (!isObject(c.conceptNames)) c.conceptNames = {}
      if (c.valueFilters !== undefined) {
        if (!Array.isArray(c.valueFilters)) errors.push(`${at}.valueFilters: must be an array.`)
        else (c.valueFilters as unknown[]).forEach((f, i) => {
          if (!isObject(f) || !VALUE_OPERATORS.includes(f.operator as string) || !isNum(f.value)
            || (f.operator === 'between' && !isNum(f.value2))) {
            errors.push(`${at}.valueFilters[${i}]: {"operator": one of ${VALUE_OPERATORS.join(' ')}, "value": n, "value2" when between}.`)
          }
        })
        if (exact && !mapping.eventTables?.[exact]?.valueColumn) {
          errors.push(`${at}.valueFilters: the "${exact}" table has no numeric value column.`)
        }
      }
      if (c.occurrenceCount !== undefined) {
        const o = c.occurrenceCount
        if (!isObject(o) || !COUNT_OPERATORS.includes(o.operator as string) || !isNum(o.count)) {
          errors.push(`${at}.occurrenceCount: {"operator": one of ${COUNT_OPERATORS.join(' ')}, "count": n}.`)
        }
      }
      break
    }
    case 'text':
      if (!mapping.noteTable) errors.push(`${path}: this database's mapping has no note table.`)
      if (!Array.isArray(c.searches) || c.searches.length === 0) {
        errors.push(`${at}.searches: a non-empty array of {"field", "terms"}.`)
      }
      if (typeof c.description !== 'string') c.description = ''
      break
  }
}

/** Concept ids of every concept criterion, grouped by event table, for name lookup. */
export function conceptIdsByTable(tree: CriteriaGroupNode): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  const walk = (n: CriteriaTreeNode) => {
    if (n.kind === 'group') return n.children.forEach(walk)
    if (n.type !== 'concept') return
    const c = n.config as { eventTableLabel: string; conceptIds: number[] }
    const set = out.get(c.eventTableLabel) ?? new Set<number>()
    c.conceptIds.forEach((id) => set.add(id))
    out.set(c.eventTableLabel, set)
  }
  walk(tree)
  return out
}

/** Fill every concept criterion's `conceptNames` from a table → id → name lookup. */
export function applyConceptNames(tree: CriteriaGroupNode, names: Map<string, Map<number, string>>): void {
  const walk = (n: CriteriaTreeNode) => {
    if (n.kind === 'group') return n.children.forEach(walk)
    if (n.type !== 'concept') return
    const c = n.config as { eventTableLabel: string; conceptIds: number[]; conceptNames: Record<number, string> }
    const known = names.get(c.eventTableLabel)
    for (const id of c.conceptIds) {
      if (c.conceptNames[id] == null) c.conceptNames[id] = known?.get(id) ?? String(id)
    }
  }
  walk(tree)
}

/** The tree as indented lines, the way the builder UI reads it. */
export function renderTree(tree: CriteriaGroupNode, mapping: SchemaMapping): string {
  const lines: string[] = []
  const walk = (n: CriteriaTreeNode, depth: number, first: boolean) => {
    const pad = '  '.repeat(depth)
    const op = first ? '' : `${n.operator} `
    const off = n.enabled ? '' : ' [disabled]'
    if (n.kind === 'group') {
      lines.push(`${pad}${op}${n.exclude ? 'NOT ' : ''}(${n.label ?? 'group'})${off}`)
      n.children.forEach((c, i) => walk(c, depth + 1, i === 0))
      return
    }
    lines.push(`${pad}${op}${getNodeLabel(n, mapping)}${off}`)
  }
  tree.children.forEach((c, i) => walk(c, 0, i === 0))
  return lines.length ? lines.join('\n') : '(no criteria: every row at this level)'
}

/** The schema mapping in plain words: which table is what, for a model that has never seen it. */
export function describeMapping(m: SchemaMapping): string {
  const q = (t?: { schema?: string; table: string }) => (t ? (t.schema ? `${t.schema}.${t.table}` : t.table) : '')
  const out: string[] = [`Data model: ${m.presetLabel?.en ?? m.presetId}`]
  const pt = m.patientTable
  if (pt) {
    const cols = [
      `id ${pt.idColumn}`,
      pt.genderColumn && `sex ${pt.genderColumn}`,
      pt.birthDateColumn && `birth date ${pt.birthDateColumn}`,
      pt.birthYearColumn && `birth year ${pt.birthYearColumn}`,
      pt.deathDateColumn && `death date ${pt.deathDateColumn}`,
    ].filter(Boolean)
    out.push(`Patients: ${q(pt)} (${cols.join(', ')})`)
    if (!pt.birthDateColumn && !pt.birthYearColumn) {
      out.push('  ⚠ no birth date/year mapped: the "age" criterion cannot work on this database.')
    }
  }
  if (m.genderValues) {
    out.push(`Sex values: male=${m.genderValues.male}, female=${m.genderValues.female}`
      + (m.genderValues.unknown ? `, unknown=${m.genderValues.unknown}` : ''))
  }
  const vt = m.visitTable
  if (vt) {
    out.push(`Visits (hospital stays, level "visit"): ${q(vt)} (id ${vt.idColumn}, patient ${vt.patientIdColumn}, `
      + `start ${vt.startDateColumn}${vt.endDateColumn ? `, end ${vt.endDateColumn}` : ''}`
      + `${vt.typeColumn ? `, type ${vt.typeColumn}` : ''})`)
  }
  const vd = m.visitDetailTable
  if (vd) {
    out.push(`Visit details (unit stays, level "visit_detail"): ${q(vd)} (id ${vd.idColumn}, visit ${vd.visitIdColumn}, `
      + `start ${vd.startDateColumn}${vd.endDateColumn ? `, end ${vd.endDateColumn}` : ''}`
      + `${vd.unitColumn ? `, unit ${vd.unitColumn}` : ''})`)
  }
  if (m.deathTable) out.push(`Deaths: ${q(m.deathTable)} (patient ${m.deathTable.patientIdColumn}, date ${m.deathTable.dateColumn})`)
  if (m.noteTable) out.push(`Notes: ${q(m.noteTable)} (text ${m.noteTable.textColumn})`)
  for (const d of m.conceptTables ?? []) {
    out.push(`Concept dictionary "${d.key}": ${q(d)} (id ${d.idColumn ?? '—'}, name ${d.nameColumn}`
      + `${d.codeColumn ? `, code ${d.codeColumn}` : ''}${d.terminologyIdColumn ? `, vocabulary ${d.terminologyIdColumn}` : ''})`)
  }
  const events = Object.entries(m.eventTables ?? {})
  if (events.length) {
    out.push('Event tables (use the quoted label as eventTableLabel in a concept criterion):')
    for (const [label, e] of events) {
      const dict = (e as { conceptDictionaryKey?: string }).conceptDictionaryKey
      out.push(`  "${label}": ${q(e)} (concept ${e.conceptIdColumn}${dict ? ` → dictionary ${dict}` : ''}`
        + `${e.valueColumn ? `, value ${e.valueColumn}` : ''}${e.valueUnitColumn ? `, unit ${e.valueUnitColumn}` : ''}`
        + `${e.dateColumn ? `, date ${e.dateColumn}` : ''})`)
    }
  }
  return out.join('\n')
}

/** Rows as a compact pipe table, cut to a character budget so one query cannot flood the context. */
export function formatRows(rows: Record<string, unknown>[], maxRows: number, maxChars = 12_000): string {
  if (rows.length === 0) return '(no rows)'
  const cols = Object.keys(rows[0])
  const cell = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return (s.length > 80 ? `${s.slice(0, 77)}...` : s).replace(/[|\n]/g, ' ')
  }
  const lines = [cols.join(' | ')]
  let shown = 0
  for (const r of rows.slice(0, maxRows)) {
    const line = cols.map((c) => cell(r[c])).join(' | ')
    if (lines.join('\n').length + line.length > maxChars) break
    lines.push(line)
    shown++
  }
  if (shown < rows.length) lines.push(`… ${rows.length - shown} more row(s) not shown (${rows.length} total).`)
  return lines.join('\n')
}
