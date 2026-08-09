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
    return naturalCompare(a.name, b.name)
  }

  const byName = naturalCompare(a.name, b.name)
  return sort.desc ? -byName : byName
}

/** Bytes of a node's text content, or undefined when it holds none. */
export function contentSize(content: string | undefined): number | undefined {
  if (content == null) return undefined
  // UTF-8 bytes, not characters: an accented or CJK file is bigger on disk than
  // its length suggests, and the size column claims to be bytes.
  return new TextEncoder().encode(content).length
}
