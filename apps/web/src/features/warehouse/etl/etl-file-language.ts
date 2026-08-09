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
 * Names an upload cannot use: they address the pipeline itself rather than a
 * script, so a file of that name would be read as pipeline structure on the next
 * export/import.
 */
const RESERVED_NAMES = new Set(['_tree.json', '_pipeline.json'])

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
