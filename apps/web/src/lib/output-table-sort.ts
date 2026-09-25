/**
 * Row order for a result table whose cells are all strings (an R/Python/SQL
 * output). The column's inferred type decides the comparison — "10" sorts after
 * "9" in a number column — and empty/null cells always go last, whichever way.
 */
export type OutputColumnType = 'number' | 'boolean' | 'date' | 'string' | 'unknown'

const NULLISH = new Set(['', 'null', 'na', 'none', 'nan'])

function isNullish(value: string | undefined): boolean {
  return value == null || NULLISH.has(value.toLowerCase())
}

export function sortOutputRows(
  rows: string[][],
  colIdx: number,
  type: OutputColumnType,
  desc: boolean,
): string[][] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  const compare = (a: string, b: string): number => {
    if (type === 'number') return Number(a) - Number(b)
    return collator.compare(a, b)
  }
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      const a = x.row[colIdx]
      const b = y.row[colIdx]
      const aNull = isNullish(a)
      const bNull = isNullish(b)
      if (aNull || bNull) return aNull === bNull ? x.i - y.i : aNull ? 1 : -1
      return (desc ? -compare(a, b) : compare(a, b)) || x.i - y.i
    })
    .map(({ row }) => row)
}
