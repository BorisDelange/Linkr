/**
 * What a pipeline is missing before its vocabulary script can run.
 *
 * A git-imported pipeline arrives with `00_vocabulary.sql` but WITHOUT
 * `mapping/source_to_concept_map.csv`: the export is gitignored by default,
 * because a mapping project is often a private dictionary. The script then reads
 * an export nobody registered, and DuckDB fails with "file not found:
 * mapping.source_to_concept_map" — a message that says nothing about the cause
 * (see `virtualCsvFiles` in run-pipeline-sql, which leaves a missing export
 * unregistered on purpose so the failure names it rather than reading stale rows).
 *
 * Stated as "which exports do the scripts READ that the pipeline does not HOLD"
 * rather than "does the STCM csv exist": the `mapping.` mechanism is general, so a
 * hand-written script referring to `mapping.units` is diagnosed by the same rule.
 */
import { mappingExportNameOf, usedMappingRefs } from '@/lib/duckdb/mapping-source'
import { treeNodePath, type TreeNode } from '@/lib/entity-tree'

/** A pipeline file, as much of it as this module needs. */
export interface VocabFile extends TreeNode {
  language?: string
  disabled?: boolean
}

export interface VocabularyReadiness {
  /** Export names a script reads but the pipeline has no file for, sorted. */
  missingExports: string[]
  /** Export names the pipeline holds but whose file is empty (header-only counts as present). */
  emptyExports: string[]
  /** True when at least one script reads a `mapping.` export. */
  usesExports: boolean
  /** Whether the pipeline holds a script that reads exports at all. */
  ready: boolean
}

/**
 * A file's content counts as an export only when it has more than a header row.
 *
 * An export regenerated from an empty filter set is a header-only CSV: the script
 * runs, source_to_concept_map ends up empty, and the failure resurfaces much later
 * as unmapped data. Worth surfacing separately from an outright missing file.
 */
function hasDataRows(content: string | undefined): boolean {
  if (!content) return false
  return content.split('\n').some((line, i) => i > 0 && line.trim().length > 0)
}

/**
 * Compare what the pipeline's enabled scripts read against what it holds.
 *
 * Disabled scripts are ignored: they are deliberately left out of a run, so an
 * export only they read is not a problem the user needs to act on.
 */
export function vocabularyReadiness(files: readonly VocabFile[]): VocabularyReadiness {
  const byId = new Map(files.map((f) => [f.id, f as TreeNode]))

  const held = new Map<string, string | undefined>()
  const referenced = new Set<string>()

  for (const f of files) {
    if (f.type !== 'file') continue
    const path = treeNodePath(f as TreeNode, byId)

    const exportName = mappingExportNameOf(path)
    if (exportName) {
      held.set(exportName, f.content)
      continue
    }

    // Only SQL is scanned: `mapping.` inside a Python or R file is not the SQL
    // string-literal form the runner rewrites.
    if (f.disabled) continue
    const isSql = f.language === 'sql' || /\.sql$/i.test(f.name)
    if (!isSql || !f.content) continue
    for (const name of usedMappingRefs(f.content)) referenced.add(name)
  }

  const missingExports = [...referenced].filter((n) => !held.has(n)).sort()
  const emptyExports = [...referenced]
    .filter((n) => held.has(n) && !hasDataRows(held.get(n)))
    .sort()

  return {
    missingExports,
    emptyExports,
    usesExports: referenced.size > 0,
    ready: missingExports.length === 0 && emptyExports.length === 0,
  }
}
