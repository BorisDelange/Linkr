import type { SchemaMapping } from '@/types/schema-mapping'
import { codesRelation, conceptRelations, eventRelations } from '@/lib/schema-classes/relations'
import { digest } from './profile-store'

/**
 * What a database's profiles were computed on: the SQL of its event relations
 * and dictionaries, and how many rows each holds. A mapping edit, rows loaded
 * or deleted, give another fingerprint, and the profiles computed under the old
 * one are stale. A value corrected in place, row count unchanged, is not seen.
 *
 * One COUNT per relation: metadata on Parquet and DuckDB files, a scan
 * elsewhere — taken when a run starts, and on demand in the Concepts tab.
 */
export async function dataFingerprint(
  mapping: SchemaMapping,
  query: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<string> {
  const relations = [...eventRelations(mapping), ...conceptRelations(mapping)]
  if (relations.length === 0) return digest('')
  // A composite-key event counted through its codes: the dictionary lookup
  // changes no row count, and costs a join.
  const counts = await query(relations
    .map((r) => `SELECT '${r.name}' AS rel, COUNT(*) AS n FROM ${r.codeSql != null ? codesRelation(r.name) : r.name}`)
    .join('\nUNION ALL\n'))
  const byName = new Map(counts.map((row) => [String(row.rel), Number(row.n)]))
  return digest(JSON.stringify(relations.map((r) => [r.name, r.sql, byName.get(r.name) ?? null])))
}
