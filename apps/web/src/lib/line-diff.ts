/**
 * Minimal line-level diff (LCS-based) for the versioning diff viewer.
 *
 * Produces a unified sequence of rows: context lines shared by both sides, then
 * deletions and additions where they differ. Good enough for reviewing an export
 * file before committing; not a full Myers diff, but stable and dependency-free.
 */

export type DiffRowType = 'context' | 'add' | 'del'

export interface DiffRow {
  type: DiffRowType
  text: string
}

export function computeLineDiff(oldText: string, newText: string): DiffRow[] {
  if (oldText === newText) {
    if (oldText === '') return []
    return oldText.split('\n').map((text) => ({ type: 'context', text }))
  }

  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')

  // LCS length table.
  const m = a.length
  const n = b.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) rows.push({ type: 'del', text: a[i++] })
  while (j < n) rows.push({ type: 'add', text: b[j++] })
  return rows
}
