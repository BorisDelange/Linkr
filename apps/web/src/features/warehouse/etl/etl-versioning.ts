import { isDataExtension } from '@/lib/entity-io'
import type { EtlPipelineConfig } from '@/types'

/**
 * Which of a pipeline's files git tracks.
 *
 * Two defaults, opposite ways round, mirroring the project IDE:
 *   - a DATA file is gitignored unless explicitly included. A pipeline's mapping
 *     export holds a dictionary that may be private, so silence must mean "not
 *     committed".
 *   - a CODE file is versioned unless explicitly excluded. Scripts are the point
 *     of the repository.
 *
 * Keys are the file's path inside the pipeline (`mapping/source_to_concept_map.csv`),
 * which is what the export tree and the .gitignore exceptions use.
 */

/** Will this path be committed, given the pipeline's marks? */
export function isVersioned(path: string, config: EtlPipelineConfig | undefined): boolean {
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
export function toggleVersioned(
  path: string,
  config: EtlPipelineConfig | undefined,
): EtlPipelineConfig {
  const current = config ?? {}
  const key: keyof EtlPipelineConfig = isDataExtension(path)
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
export function setVersionedMany(
  paths: string[],
  versioned: boolean,
  config: EtlPipelineConfig | undefined,
): EtlPipelineConfig {
  const current = config ?? {}
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
export function pruneVersioningMarks(
  config: EtlPipelineConfig | undefined,
  existingPaths: Iterable<string>,
): EtlPipelineConfig | undefined {
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
