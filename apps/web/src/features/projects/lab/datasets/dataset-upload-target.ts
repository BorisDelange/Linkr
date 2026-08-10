/**
 * Where a dataset upload lands, given the user's choice in the conflict banner.
 *
 * Pure, because getting it wrong is silent and expensive: the previous version
 * deleted the existing dataset before re-importing in server mode, which dropped
 * the analyses and versioning marks attached to its id — while the front-only
 * branch reimported in place and kept them. Two behaviours for one action.
 *
 * The rule that makes this simple: in server mode a dataset's identity IS its
 * path, so importing under the SAME name replaces the file and lands on the same
 * id. Nothing needs deleting.
 */
import { uniqueFileName } from '@/lib/unique-name'

export type DatasetUploadMode = 'new' | 'overwrite' | 'copy'

export interface DatasetSibling {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
}

export interface DatasetUploadTarget {
  /** The name to import under. */
  name: string
  /** The dataset being replaced, when this is an overwrite. */
  replacesId?: string
}

/**
 * The sibling an upload would collide with, or null.
 *
 * Case-insensitive: two names differing only in case are one file to git on macOS
 * and Windows, and the export tree could not hold both. Matching exactly meant the
 * user was never offered the overwrite choice for what is, to them, the same file.
 */
export function findDatasetConflict(
  fileName: string,
  parentId: string | null,
  siblings: readonly DatasetSibling[],
): DatasetSibling | null {
  const target = fileName.toLowerCase()
  return siblings.find(
    (f) => f.type === 'file' && f.parentId === parentId && f.name.toLowerCase() === target,
  ) ?? null
}

/**
 * Resolve the upload to a concrete name (+ the id it replaces, if any).
 *
 * 'overwrite' reuses the EXISTING name rather than the uploaded casing, so
 * "Data.csv" over "data.csv" replaces it instead of landing beside it. 'copy'
 * takes the next free filename; 'new' is only reached when there is no clash.
 */
export function resolveDatasetUploadTarget(
  fileName: string,
  parentId: string | null,
  siblings: readonly DatasetSibling[],
  mode: DatasetUploadMode,
): DatasetUploadTarget {
  const clash = findDatasetConflict(fileName, parentId, siblings)
  if (mode === 'overwrite' && clash) {
    return { name: clash.name, replacesId: clash.id }
  }
  if (mode === 'copy' || clash) {
    const taken = siblings
      .filter((f) => f.type === 'file' && f.parentId === parentId)
      .map((f) => f.name)
    return { name: uniqueFileName(fileName, taken) }
  }
  return { name: fileName }
}
