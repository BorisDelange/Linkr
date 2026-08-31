import { naturalCompare } from '@/lib/format-helpers'
import type { EtlFile } from '@/types'

/**
 * Execution order of a pipeline's scripts: by `order`, ties broken by name.
 *
 * `order` is not unique — nothing enforces it, and it is never recompacted after
 * a delete, so pipelines written before `nextEtlOrder` (and repos carrying the
 * duplicate in their `_tree.json`) hold collisions. A bare `a.order - b.order`
 * leaves those to the sort's stability, i.e. to whatever order the storage
 * returned: the IDB index on one instance, a different one on another. The
 * pipeline would then run its steps in a different sequence per instance,
 * silently — a step reading a table an earlier one has not written yet produces
 * zeros, not an error.
 *
 * Natural comparison on the name as the tiebreak, so tied scripts fall back to
 * the sequence their `00_`/`10_`/`35_` prefixes already spell out.
 *
 * Lives in lib/ rather than beside the ETL feature so the store can use it too —
 * stores never import from features/.
 */
export function compareEtlFilesByOrder(
  a: Pick<EtlFile, 'name' | 'order'>,
  b: Pick<EtlFile, 'name' | 'order'>,
): number {
  return a.order !== b.order ? a.order - b.order : naturalCompare(a.name, b.name)
}
