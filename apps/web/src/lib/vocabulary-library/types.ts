/** One vocabulary held by a workspace's library (`connectionConfig.vocabularies`
 *  of the library data source). */
export interface LibraryVocabulary {
  vocabularyId: string
  vocabularyName: string | null
  vocabularyVersion: string | null
  /** The ATHENA release it came with (`v5.0 27-FEB-26`). */
  release: string | null
  conceptCount: number
  rowCounts?: Record<string, number>
  /** Where it was imported from (folder name, server path). */
  source: string
  importedAt: string
  /** Server mode: size of its partitions on disk. */
  sizeBytes?: number
  /** Front-only: the import (hidden vocabulary database) whose rows it reads. */
  importDataSourceId?: string
}

/** Front-only: what an ATHENA import (a hidden vocabulary database) holds. */
export interface VocabularyImportInventory {
  release: string | null
  vocabularies: { vocabularyId: string; vocabularyName: string | null; vocabularyVersion: string | null; conceptCount: number }[]
  source: string
  importedAt: string
}

/** A vocabulary an ATHENA export holds, against what the library has. */
export interface InspectedVocabulary {
  vocabularyId: string
  vocabularyName: string | null
  vocabularyVersion: string | null
  conceptCount: number
  inLibrary: boolean
  libraryVersion: string | null
}

export interface InspectedExport {
  release: string | null
  tables: string[]
  vocabularies: InspectedVocabulary[]
}

/** What the import preview proposes for one vocabulary. */
export type VocabularyImportStatus = 'new' | 'same' | 'other'

export function importStatus(v: InspectedVocabulary): VocabularyImportStatus {
  if (!v.inLibrary) return 'new'
  return v.libraryVersion === v.vocabularyVersion ? 'same' : 'other'
}

/** New and changed vocabularies are ticked; one already held at this version is
 *  not — its rows are already there. */
export function defaultSelection(vocabularies: readonly InspectedVocabulary[]): Set<string> {
  return new Set(vocabularies.filter((v) => importStatus(v) !== 'same').map((v) => v.vocabularyId))
}

/** The ATHENA releases the library's vocabularies come from, sorted. More than
 *  one = a mixed library (kept older vocabularies next to newer ones). */
export function libraryReleases(vocabularies: readonly LibraryVocabulary[]): string[] {
  return [...new Set(vocabularies.map((v) => v.release).filter((r): r is string => !!r))].sort()
}
