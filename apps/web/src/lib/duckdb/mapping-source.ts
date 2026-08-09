/**
 * `mapping.<name>` — data a pipeline's mapping project exports for its scripts.
 *
 * The vocabulary script used to inline every mapping as literal `VALUES`, which
 * put the source codes of a private dictionary into a git-versioned file. The
 * rows now live in a CSV beside the pipeline, gitignored, and the script refers
 * to it by name:
 *
 *     SELECT * FROM read_csv('mapping.source_to_concept_map')
 *
 * This is deliberately NOT a fourth role prefix. `source.`/`target.`/`vocab.`
 * resolve to DuckDB schemas and are rewritten as qualifiers; a mapping export is
 * a file, so it appears inside a string literal — exactly the region the role
 * rewriter skips on purpose.
 */

/** Folder holding a pipeline's mapping exports, relative to the pipeline. */
export const MAPPING_DIR = 'mapping'

/** The STCM export: one row per concept mapping. */
export const STCM_EXPORT = 'source_to_concept_map'

/** `mapping.<name>` inside a string literal, the only place it is meaningful. */
const MAPPING_REF = /(['"])mapping\.([a-z_][a-z0-9_]*)\1/gi

/**
 * Rewrite every `'mapping.<name>'` to the real location of that export.
 *
 * `resolve` returns the path (or URL) a DuckDB reader can open, or undefined
 * when the export does not exist — the reference is then left as written, so the
 * error names the missing export rather than a path that means nothing.
 */
export function resolveMappingRefs(
  sql: string,
  resolve: (name: string) => string | undefined,
): string {
  return sql.replace(MAPPING_REF, (match, _quote: string, name: string) => {
    const path = resolve(name.toLowerCase())
    if (path === undefined) return match
    // Single-quote the result whatever quote the author used: it is a SQL string
    // literal, and a double-quoted one would read as an identifier.
    return `'${path.replace(/'/g, "''")}'`
  })
}

/** Mapping exports a script refers to, so the caller knows what to materialise. */
export function usedMappingRefs(sql: string): string[] {
  const found = new Set<string>()
  for (const m of sql.matchAll(MAPPING_REF)) found.add(m[2].toLowerCase())
  return [...found].sort()
}

/** Where a pipeline's export lives, as a path inside the pipeline folder. */
export function mappingExportPath(name: string): string {
  return `${MAPPING_DIR}/${name}.csv`
}
