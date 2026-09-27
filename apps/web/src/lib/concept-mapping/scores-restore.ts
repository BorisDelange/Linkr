/**
 * Restoring the similarity scores an export tree carries — the one path every
 * import takes (standalone ZIP, git clone, workspace ZIP, seed). A tree holds a
 * `similarity-scores.parquet`, per-method `similarity-scores/<method>.csv`
 * (the versioned form), or both: the parquet is loaded first, then each CSV
 * replaces its method's rows.
 */
import type JSZip from 'jszip'
import { SCORES_PARQUET_FILE, methodForCsvPath } from './scores-csv'

export interface ImportedScores {
  parquet: Uint8Array | null
  csvs: { method: string; bytes: Uint8Array }[]
}

export const NO_SCORES: ImportedScores = { parquet: null, csvs: [] }

export function hasScores(scores: ImportedScores): boolean {
  return (scores.parquet?.byteLength ?? 0) > 0 || scores.csvs.length > 0
}

/** Is `path` (relative to the entity folder) a scores payload? Text readers skip
 *  these: they are binary, or too large to decode for nothing. */
export function isScoresPath(path: string): boolean {
  return path === SCORES_PARQUET_FILE || methodForCsvPath(path) !== null
}

/** The scores under `prefix` in a JSZip. */
export async function readScoresFromZip(zip: JSZip, prefix = ''): Promise<ImportedScores> {
  const parquetEntry = zip.files[`${prefix}${SCORES_PARQUET_FILE}`]
  const parquet = parquetEntry && !parquetEntry.dir ? await parquetEntry.async('uint8array') : null
  const csvs: ImportedScores['csvs'] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.startsWith(prefix)) continue
    const method = methodForCsvPath(path.slice(prefix.length))
    if (method) csvs.push({ method, bytes: await entry.async('uint8array') })
  }
  csvs.sort((a, b) => (a.method < b.method ? -1 : 1))
  return { parquet: parquet && parquet.byteLength > 0 ? parquet : null, csvs }
}

/** Persist imported scores for a project (either mode). Throws on an invalid
 *  file; callers that must not lose the project over it catch. */
export async function restoreImportedScores(projectId: string, scores: ImportedScores): Promise<void> {
  if (!hasScores(scores)) return
  const { useSuggestionScoresStore } = await import('@/stores/suggestion-scores-store')
  const store = useSuggestionScoresStore.getState()
  if (scores.parquet) {
    const file = new File([scores.parquet as BlobPart], `${projectId}.parquet`, { type: 'application/octet-stream' })
    await store.importScores(projectId, file)
  }
  if (scores.csvs.length > 0) await store.importMethodCsvs(projectId, scores.csvs)
}
