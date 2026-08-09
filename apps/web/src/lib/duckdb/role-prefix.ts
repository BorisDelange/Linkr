/**
 * ETL scripts address the two pipeline databases by ROLE (`source.`, `target.`)
 * rather than by their DuckDB schema (`ds_<alias>`). The schema name embeds an
 * instance-local alias/UUID, so a script hard-coding it breaks as soon as the
 * pipeline is exported and reimported elsewhere. Roles survive: the importing
 * user rebinds the two dropdowns and every script keeps working.
 *
 * The prefixes are resolved at execution time, so what is stored on disk (and
 * in git) stays portable.
 */

// String literals, quoted identifiers, comments and dollar-quoted blocks — a
// role prefix inside any of them is data or prose, not a qualifier. Shared with
// the statement splitter so both agree on what SQL is.
import { isProtected, protectedRegions } from './sql-tokenizer'

/** The role prefixes a script may use, in the order they are matched. */
export const ROLE_PREFIXES = ['source', 'target', 'vocab'] as const

export type RolePrefix = (typeof ROLE_PREFIXES)[number]

/** Schema each role resolves to, or undefined when the pipeline has no such DB. */
export interface RoleSchemas {
  source?: string
  target?: string
  /** ATHENA reference of the pipeline's mapping project (vocabularyDataSourceId). */
  vocab?: string
}

/**
 * Matches `source.` / `target.` used as a schema qualifier.
 *
 * The leading group keeps the rewrite from firing on something that is not a
 * qualifier: a word character or `.` before the role means it is part of a
 * longer identifier (`my_source.x`, `a.target.b`), and a quote means the caller
 * already wrote an explicit schema. Only the role + dot is replaced, so the
 * table name that follows is untouched.
 */
const ROLE_QUALIFIER = /(^|[^\w."'`])(source|target|vocab)\.(?=[\w"])/gi

/** Roles actually referenced as a qualifier in the SQL (ignoring literals/comments). */
export function usedRoles(sql: string): RolePrefix[] {
  const regions = protectedRegions(sql)
  const found = new Set<RolePrefix>()
  for (const m of sql.matchAll(ROLE_QUALIFIER)) {
    const roleAt = m.index + m[1].length
    if (isProtected(regions, roleAt)) continue
    found.add(m[2].toLowerCase() as RolePrefix)
  }
  return ROLE_PREFIXES.filter((r) => found.has(r))
}

/**
 * Replace `source.` / `target.` qualifiers with the real DuckDB schemas.
 *
 * A role with no schema bound (pipeline missing that database) is left as-is:
 * the resulting SQL error names `source`/`target`, which is far more legible
 * than a silently-dropped qualifier resolving to the wrong database.
 */
export function resolveRolePrefixes(sql: string, schemas: RoleSchemas): string {
  const regions = protectedRegions(sql)
  return sql.replace(ROLE_QUALIFIER, (match, lead: string, role: string, offset: number) => {
    if (isProtected(regions, offset + lead.length)) return match
    const schema = schemas[role.toLowerCase() as RolePrefix]
    if (schema === undefined) return match
    // '' means "this is the database the query already runs against" (server
    // mode): drop the qualifier so the bare name resolves via search_path.
    if (schema === '') return lead
    return `${lead}"${schema}".`
  })
}
