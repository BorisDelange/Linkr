import { ENTITY_MANIFEST, MANIFEST, SIDECAR } from '@linkr/format'
import { naturalCompare } from '@/lib/format-helpers'
import type { EtlFile } from '@/types'

/** Language of an ETL file from its name, or undefined when nothing fits. */
export function inferEtlLanguage(name: string): EtlFile['language'] | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'sql') return 'sql'
  if (ext === 'py') return 'python'
  // .Rmd stays R (it is an R notebook), so it must be tested before plain .md.
  if (ext === 'r' || ext === 'rmd') return 'r'
  if (ext === 'md') return 'markdown'
  return undefined
}

/**
 * How a language is written for a reader: SQL, Python, R, Markdown.
 *
 * The stored value is a lowercase identifier (`sql`, `r`), which is right for
 * code and wrong in a sidebar — "Language sql" reads like a bug. Unknown values
 * are capitalised rather than dropped, so a language added later still shows
 * something sensible without touching this.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  sql: 'SQL',
  python: 'Python',
  r: 'R',
  markdown: 'Markdown',
}

export function etlLanguageLabel(language: string | undefined): string {
  if (!language) return '—'
  return LANGUAGE_LABELS[language.toLowerCase()]
    ?? language.charAt(0).toUpperCase() + language.slice(1)
}

/**
 * Names an upload cannot use: they address the pipeline itself rather than a
 * script, so a file of that name would be read as pipeline structure on the next
 * export/import.
 */
const RESERVED_NAMES = new Set([SIDECAR.tree, ENTITY_MANIFEST, MANIFEST['etl-pipeline']])

/**
 * A name safe to store as an ETL file, or undefined when the upload must be
 * refused. Path separators are stripped: a browser can hand back
 * `folder/file.sql` for a directory drop, and the tree stores hierarchy in
 * `parentId`, not in the name.
 */
export function safeEtlFileName(rawName: string): string | undefined {
  const base = rawName.split(/[\\/]/).pop()?.trim()
  if (!base || base === '.' || base === '..') return undefined
  if (RESERVED_NAMES.has(base.toLowerCase())) return undefined
  return base
}

/** A name not already taken among `existing`, suffixed `-2`, `-3`, … if needed. */
export function uniqueEtlFileName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name

  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Display order for the Scripts explorer: folders first, then by name.
 *
 * Natural comparison, so the numeric prefixes a pipeline conventionally uses
 * (`00_`, `10_`, `35_`) read in their intended order — a plain string sort puts
 * `10_` before `2_`.
 *
 * This is DISPLAY order only. The Pipeline tab keeps sorting by `order`, which
 * is the user's own execution sequence: the two are deliberately independent, so
 * renaming a script cannot silently change what runs when.
 */
export function compareEtlFilesByName(
  a: Pick<EtlFile, 'name' | 'type'>,
  b: Pick<EtlFile, 'name' | 'type'>,
): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
  return naturalCompare(a.name, b.name)
}

/**
 * New `order` values that put the scripts in name order, keyed by file id.
 *
 * Execution order is the user's own (drag to reorder), but a pipeline's scripts
 * are conventionally named for the sequence they belong in — `00_vocabulary`,
 * `10_src_core`, `35_drug_exposure`. When the two disagree the run is silently
 * wrong rather than failing: a step reads a table an earlier one has not written
 * yet and quietly produces zeros. This realigns the two in one action.
 *
 * Only entries whose order actually changes are returned, so the caller writes
 * the minimum.
 */
export function orderByNamePatch(
  files: Pick<EtlFile, 'id' | 'name' | 'type' | 'order'>[],
): Map<string, number> {
  const sorted = [...files].sort(compareEtlFilesByName)
  const patch = new Map<string, number>()
  sorted.forEach((f, index) => {
    if (f.order !== index) patch.set(f.id, index)
  })
  return patch
}

/**
 * The `order` to give a file created in `files` (a whole pipeline's nodes).
 *
 * Max + 1, never `files.length`: `order` has no unique index and nothing
 * recompacts it after a delete, so a count collides with a value still in use.
 * Delete the file at order 2 of 0..5 and the count is 5 — the order the last
 * file still holds. Two files then share a rank, `sort((a, b) => a.order -
 * b.order)` falls back to the storage's own order, and the pipeline runs in a
 * sequence that differs between instances.
 *
 * Counts the pipeline's whole tree, matching the reindex the Pipeline tab's
 * drag/sort-by-name applies, so a new file always lands after every existing one.
 * Generated scripts sit at negative orders (see EtlVocabularyTab), which a max
 * naturally leaves alone.
 */
export function nextEtlOrder(files: Pick<EtlFile, 'order'>[]): number {
  return files.reduce((max, f) => (Number.isFinite(f.order) && f.order > max ? f.order : max), -1) + 1
}
