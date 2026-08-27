import { isDataExtension } from '@/lib/entity-io'
import { treeNodePath, type TreeNode } from '@/lib/entity-tree'
import type { EntityFilesConfig } from '@/types'

/**
 * Which of an entity's files git tracks.
 *
 * Two defaults, opposite ways round, mirroring the project IDE:
 *   - a DATA file is gitignored unless explicitly included. A pipeline's mapping
 *     export holds a dictionary that may be private, so silence must mean "not
 *     committed".
 *   - a CODE file is versioned unless explicitly excluded. Scripts are the point
 *     of the repository.
 *
 * Keys are the file's path inside the entity (`mapping/source_to_concept_map.csv`,
 * `cohorts/sepsis.sql`), which is what the export tree and the .gitignore
 * exceptions use.
 *
 * Shared by ETL pipelines and SQL script collections. The mutators are generic
 * over the config so an entity's own extra keys (ETL's `vocabulary`) survive a
 * toggle in the type as well as at runtime.
 */

/** Will this path be committed, given the entity's marks? */
export function isVersioned(path: string, config: EntityFilesConfig | undefined): boolean {
  if (isDataExtension(path)) return (config?.versionedDataFiles ?? []).includes(path)
  return !(config?.excludedFiles ?? []).includes(path)
}

/**
 * The config after toggling one path, or the same object when nothing changes.
 *
 * Which list is touched follows the file's kind, so the caller does not have to
 * know the rule — a data file moves in and out of `versionedDataFiles`, a code
 * file in and out of `excludedFiles`.
 */
export function toggleVersioned<T extends EntityFilesConfig>(
  path: string,
  config: T | undefined,
): T & EntityFilesConfig {
  const current = (config ?? {}) as T
  const key: keyof EntityFilesConfig = isDataExtension(path)
    ? 'versionedDataFiles'
    : 'excludedFiles'
  const list = current[key] ?? []
  const next = list.includes(path)
    ? list.filter((p) => p !== path)
    // Sorted, so the stored value does not depend on the order things were
    // clicked — otherwise every toggle shows up as a diff in the export.
    : [...list, path].sort()
  return { ...current, [key]: next }
}

/**
 * The config after forcing several paths to `versioned`.
 *
 * Not a loop of `toggleVersioned`: a mixed selection would flip each file to the
 * opposite of what it was and stay mixed. A bulk action means "make all of these
 * versioned" (or not), so the target state is explicit.
 */
export function setVersionedMany<T extends EntityFilesConfig>(
  paths: string[],
  versioned: boolean,
  config: T | undefined,
): T & EntityFilesConfig {
  const current = (config ?? {}) as T
  const data = paths.filter((p) => isDataExtension(p))
  const code = paths.filter((p) => !isDataExtension(p))

  // A data path is listed when INCLUDED; a code path when EXCLUDED. The two
  // lists therefore move in opposite directions for the same request.
  const apply = (list: string[] | undefined, subject: string[], add: boolean): string[] => {
    const set = new Set(list ?? [])
    for (const p of subject) {
      if (add) set.add(p)
      else set.delete(p)
    }
    return [...set].sort()
  }

  return {
    ...current,
    versionedDataFiles: apply(current.versionedDataFiles, data, versioned),
    excludedFiles: apply(current.excludedFiles, code, !versioned),
  }
}

/**
 * Drop marks for paths that no longer exist.
 *
 * A renamed or deleted file would otherwise leave an entry behind for ever,
 * and a new file later taking that name would silently inherit its state.
 */
export function pruneVersioningMarks<T extends EntityFilesConfig>(
  config: T | undefined,
  existingPaths: Iterable<string>,
): (T & EntityFilesConfig) | undefined {
  if (!config) return undefined
  const alive = new Set(existingPaths)
  const keep = (list: string[] | undefined) => (list ?? []).filter((p) => alive.has(p))
  const versionedDataFiles = keep(config.versionedDataFiles)
  const excludedFiles = keep(config.excludedFiles)
  if (
    versionedDataFiles.length === (config.versionedDataFiles?.length ?? 0)
    && excludedFiles.length === (config.excludedFiles?.length ?? 0)
  ) {
    return config
  }
  return { ...config, versionedDataFiles, excludedFiles }
}

/** Every file path in a tree, as the marks key them. */
export function treeFilePaths(files: TreeNode[]): string[] {
  const byId = new Map(files.map((f) => [f.id, f]))
  return files.filter((f) => f.type === 'file').map((f) => treeNodePath(f, byId))
}

/**
 * The pruned config for a tree, or `null` when nothing changed.
 *
 * `null` is the signal to skip the write: `pruneVersioningMarks` returns the
 * same object when every mark is still live, and persisting that would bump
 * `updatedAt` — and so the export — on every unrelated file deletion.
 *
 * Call this AFTER a DELETE, against the surviving nodes. Not after a rename: a
 * renamed file keeps its mark, and pruning would silently re-version a script
 * the user had excluded. Rename re-keys instead — see `renameVersioningMark`.
 */
export function prunedConfigForTree<T extends EntityFilesConfig>(
  config: T | undefined,
  files: TreeNode[],
): (T & EntityFilesConfig) | null {
  if (!config) return null
  const pruned = pruneVersioningMarks(config, treeFilePaths(files))
  return pruned === config ? null : pruned ?? null
}

/**
 * The config after a file moves from one path to another, or `null` when no
 * mark was affected.
 *
 * A mark is a path, so renaming or moving a marked file would otherwise strand
 * it: the mark would keep pointing at a path nothing occupies, the file would
 * revert to its default (a versioned script silently re-included), and a later
 * file taking the old name would inherit a state its author never chose.
 *
 * Folders move whole subtrees, so this matches on the path prefix as well as on
 * the path itself.
 */
export function renameVersioningMark<T extends EntityFilesConfig>(
  config: T | undefined,
  from: string,
  to: string,
): (T & EntityFilesConfig) | null {
  if (!config || from === to) return null
  let touched = false
  const remap = (list: string[] | undefined): string[] => (list ?? []).map((p) => {
    const moved = p === from ? to
      : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}`
      : p
    if (moved !== p) touched = true
    return moved
  }).sort()
  const versionedDataFiles = remap(config.versionedDataFiles)
  const excludedFiles = remap(config.excludedFiles)
  return touched ? { ...config, versionedDataFiles, excludedFiles } : null
}
