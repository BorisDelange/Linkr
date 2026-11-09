/**
 * Fills the tokens of the catalog's query templates (`catalog-queries.ts`)
 * with what earlier results decided. The server fills the same templates with
 * its twin (apps/api services/server_runs/catalog/compute.py `fill_catalog_sql`):
 * change one, change the other and regenerate the twin fixture
 * (catalog-run-spec.twin.test.ts).
 */

import { escSql } from '@/lib/format-helpers'
import { boundPicks, rangeCondition, type ConceptFilter, type PatientRange } from './catalog-queries'

export interface CatalogFill {
  /** The patient slice; absent for the whole warehouse. */
  range?: PatientRange | null
  /** Slices the patient bounds cut the warehouse in. */
  slices?: number
  /** Services a top-N grouping keeps. */
  topServices?: readonly string[]
  /** Concept modalities to keep, per dictionary; absent keeps them all. */
  conceptFilter?: ConceptFilter | null
  /** The dictionaries' keys, in the order the concept tokens number them. */
  dictKeys?: readonly string[]
}

const lit = (v: string | number) => (typeof v === 'number' ? String(v) : `'${escSql(v)}'`)

const TOKEN = /^\/\*LINKR_([A-Z_]+)(?::([^*]*))?\*\/$/

/**
 * The block comments of `sql` outside its literals, quoted identifiers and line
 * comments — so a service named like a token stays a name.
 */
function blockComments(sql: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      let close = sql.indexOf(c, i + 1)
      // A doubled quote is one quote of the literal.
      while (close >= 0 && sql[close + 1] === c) close = sql.indexOf(c, close + 2)
      if (close < 0) break
      i = close + 1
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      if (nl < 0) break
      i = nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      if (close < 0) break
      out.push({ start: i, end: close + 2 })
      i = close + 2
      continue
    }
    i++
  }
  return out
}

function filled(name: string, arg: string | undefined, fill: CatalogFill): string | null {
  if (name === 'RANGE' && arg) {
    const sep = arg.indexOf(':')
    const kind = arg.slice(0, sep)
    const condition = rangeCondition(arg.slice(sep + 1), fill.range)
    if (kind !== 'WHERE' && kind !== 'AND') return null
    return condition ? ` ${kind} ${condition}` : ''
  }
  if (name === 'BOUND_PICKS') {
    if (fill.slices == null) throw new Error('The patient bounds query needs its slice count')
    return boundPicks(fill.slices)
  }
  if (name === 'SERVICE_TOP') {
    const top = fill.topServices ?? []
    return top.length ? top.map(lit).join(', ') : 'NULL'
  }
  if (name === 'CONCEPT_IN' && arg) {
    if (!fill.conceptFilter) return ''
    const sep = arg.indexOf(':')
    const dictKey = fill.dictKeys?.[Number(arg.slice(0, sep))]
    const ids = fill.conceptFilter.find((f) => f.dictKey === dictKey)?.ids
    // A dictionary with nothing kept counts nothing, rather than its part being cut out.
    return ids?.length ? ` AND ${arg.slice(sep + 1)} IN (${ids.map(lit).join(', ')})` : ' AND FALSE'
  }
  return null
}

/** `sql` with its catalog tokens replaced; a token it does not know is left as the comment it is. */
export function fillCatalogSql(sql: string, fill: CatalogFill = {}): string {
  let out = ''
  let at = 0
  for (const { start, end } of blockComments(sql)) {
    const m = TOKEN.exec(sql.slice(start, end))
    const value = m ? filled(m[1], m[2], fill) : null
    if (value == null) continue
    out += sql.slice(at, start) + value
    at = end
  }
  return out + sql.slice(at)
}
