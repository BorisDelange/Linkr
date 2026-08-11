import { naturalCompare } from '@/lib/format-helpers'
import type { FileTreeSort } from '@/components/ui/file-tree-header'

/** The minimum a file explorer row must expose to be ordered. */
export interface SortableNode {
  name: string
  type: 'file' | 'folder'
  /** Bytes, when known. A tree whose nodes hold text can measure it. */
  size?: number
}

/**
 * Order for a file explorer: folders first, then the chosen column.
 *
 * Folders lead whichever way the sort points — they are containers, not entries
 * to compare, and letting them fall among the files by size (they have none)
 * scatters the structure. Names compare naturally, so `10_` follows `2_` rather
 * than preceding it.
 */
export function compareTreeNodes(a: SortableNode, b: SortableNode, sort: FileTreeSort): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1

  if (sort.key === 'size') {
    // An unknown size sorts as 0 rather than dropping to the bottom: "unknown"
    // and "empty" look the same to the reader, and a stable place is friendlier
    // than a mixed pile.
    const diff = (a.size ?? 0) - (b.size ?? 0)
    // Ties fall back to the name, so the order does not shuffle between renders.
    if (diff !== 0) return sort.desc ? -diff : diff
    return byNameThenCodepoint(a.name, b.name)
  }

  const byName = byNameThenCodepoint(a.name, b.name)
  return sort.desc ? -byName : byName
}

/**
 * `naturalCompare`, with a codepoint tiebreak.
 *
 * `naturalCompare` compares with `sensitivity: 'base'`, so `a.sql` and `A.sql`
 * (and NFC vs NFD) come back EQUAL — which left the "ties fall back to the name"
 * promise above unfulfilled for exactly those pairs: the order then depended on
 * the store's insertion order and could shuffle across a reload.
 *
 * Display-only. The export tree sorts by raw path (`entity-tree.ts`), so this
 * cannot perturb the byte-parity the golden twins guard.
 */
function byNameThenCodepoint(a: string, b: string): number {
  return naturalCompare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Width (in `ch`) for the size column, from the widest label actually present.
 *
 * A fixed width has to assume the worst case ("1000 ko"), which leaves a visible
 * gap between the versioning icon and the sizes when every file is "5 ko". Sizing
 * to the real content keeps the columns tight AND aligned, since every row is
 * given the same measured width.
 *
 * `ch` because the labels are rendered with `tabular-nums`, where every digit is
 * one `ch` wide — so the count of characters is the width.
 */
export function sizeColumnWidthCh(labels: (string | undefined)[]): number {
  let widest = 0
  for (const label of labels) {
    if (label) widest = Math.max(widest, label.length)
  }
  // Never collapse to nothing: with no sizes at all the column disappears, and a
  // minimum keeps the icons off the right edge.
  return Math.max(widest, 4)
}

/** Bytes of a node's text content, or undefined when it holds none. */
export function contentSize(content: string | undefined): number | undefined {
  if (content == null) return undefined
  // UTF-8 bytes, not characters: an accented or CJK file is bigger on disk than
  // its length suggests, and the size column claims to be bytes.
  return new TextEncoder().encode(content).length
}
