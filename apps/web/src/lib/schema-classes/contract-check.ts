import { blankSqlLiterals } from './relations'
import { CLASS_CONTRACTS, type ClassName, type ColumnKind } from './contracts'

/** One row of `DESCRIBE <query>`: the columns a relation's SQL actually returns. */
export interface DescribedColumn {
  column_name: string
  column_type: string
}

export interface ContractReport {
  /** Contract columns the SQL returns with a real type: what it fills. */
  filled: string[]
  /** Required contract columns it does not return, or returns as bare NULL. */
  missingRequired: string[]
  /** Returned columns the contract does not know: ignored by every consumer. */
  unknown: string[]
  /** Contract columns returned with a type that does not fit (`start_datetime` as VARCHAR). */
  typeMismatches: { column: string; type: string; expected: ColumnKind }[]
  /** A window over the whole relation (`OVER (ORDER BY …)` without PARTITION BY):
   *  it stops a per-patient filter from being pushed into the relation. */
  globalWindow: boolean
}

const EXTRA = /^extra_[A-Za-z0-9_]+$/

/** Does a DuckDB type fit a contract column kind? Ids take any type (VARCHAR or
 *  BIGINT); a bare NULL (`NULL AS x`) has type "NULL" and fills nothing. */
function fits(kind: ColumnKind, type: string): boolean {
  const t = type.toUpperCase()
  switch (kind) {
    case 'datetime':
    case 'date':
      return t.startsWith('TIMESTAMP') || t === 'DATE'
    case 'number':
      return /INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL|HUGEINT/.test(t)
    case 'boolean':
      return t === 'BOOLEAN'
    default:
      return true
  }
}

/**
 * Compare what a relation's SQL returns (`DESCRIBE`) with its class contract
 * (plan §6, "Contract check"). The report drives the SQL dialog's check tab and
 * `sqlColumns`, the columns a hand-written relation is known to fill.
 */
export function checkContract(cls: ClassName, described: readonly DescribedColumn[], sql = ''): ContractReport {
  const contract = CLASS_CONTRACTS[cls]
  const byName = new Map(described.map((d) => [d.column_name.toLowerCase(), d.column_type]))
  const known = new Set(contract.map((c) => c.name))
  const filled: string[] = []
  const typeMismatches: ContractReport['typeMismatches'] = []
  for (const c of contract) {
    const type = byName.get(c.name)
    if (!type || type.toUpperCase() === 'NULL') continue
    filled.push(c.name)
    if (!fits(c.kind, type)) typeMismatches.push({ column: c.name, type, expected: c.kind })
  }
  for (const d of described) {
    const name = d.column_name.toLowerCase()
    if (cls === 'concept' && EXTRA.test(name) && d.column_type.toUpperCase() !== 'NULL') filled.push(name)
  }
  return {
    filled,
    missingRequired: contract.filter((c) => c.required && !filled.includes(c.name)).map((c) => c.name),
    unknown: described
      .map((d) => d.column_name)
      .filter((n) => !known.has(n.toLowerCase()) && !(cls === 'concept' && EXTRA.test(n.toLowerCase()))),
    typeMismatches,
    globalWindow: hasGlobalWindow(sql),
  }
}

/** `OVER (…)` with no PARTITION BY — a window over every row of the relation. */
export function hasGlobalWindow(sql: string): boolean {
  const text = blankSqlLiterals(sql)
  for (const m of text.matchAll(/\bOVER\s*\(/gi)) {
    let depth = 1
    let i = (m.index ?? 0) + m[0].length
    const start = i
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') depth--
      i++
    }
    if (!/\bPARTITION\s+BY\b/i.test(text.slice(start, i - 1))) return true
  }
  return false
}
