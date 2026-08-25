/**
 * Serialize a database: metadata plus a `data/` folder of Parquet tables.
 *
 * This is the one entity whose tree carries **data**, and the only one whose
 * serializer returns copies alongside generated files — Parquet is binary and
 * megabytes wide, so this package (no I/O, no dependencies) declares which file
 * goes where and the caller performs the copy. See `CopyFile`.
 *
 * **The app never writes this tree.** Its export deliberately emits metadata and
 * not one row, so it can never be the path by which patient data leaves a
 * hospital (`buildDataSourceFolder` in entity-io.ts). Authoring one here is
 * allowed because this runs outside that context — which is exactly why the
 * rule attached to it matters: synthetic or public open data only, never a
 * connected database. See docs/planning/default-data-repos-plan.md §11.
 */
import { canonicalSchemaMapping } from '../schema-mapping.js'
import type { CopyFile, LocalizedInput, SerializedTree, WriteFile } from './project.js'

/** One table of the database: a Parquet file to copy into `data/`. */
export interface DatabaseTableSpec {
  /**
   * Table name as SQL will address it. The file becomes `data/<name>.parquet`,
   * so this is also the file's basename — the app derives one from the other.
   */
  name: string
  /** Path of the Parquet file to copy in. */
  source: string
}

export interface DatabaseSpec {
  /** Stable identity, e.g. `mimic-iv-demo`. Travels across instances. */
  id: string
  /** Short, URL-safe name used as the DuckDB schema name, e.g. `mimic_iv_demo`. */
  alias: string
  name: LocalizedInput
  description?: LocalizedInput
  /**
   * How to read the tables: a schema preset id (`omop-5.4`) or an inline
   * mapping. An id must resolve on the importing instance — ship the preset
   * repo alongside, or inline the mapping if unsure.
   */
  schema: string | Record<string, unknown>
  /** The tables. Empty is allowed: an in-memory target database has none. */
  tables?: DatabaseTableSpec[]
  /** True for a database with no data files (e.g. an ETL target). */
  inMemory?: boolean
  /** True when the database is a vocabulary reference (ATHENA). */
  isVocabularyReference?: boolean
  /** User-facing semver; defaults to `0.1.0` like every other entity. */
  version?: string
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function localized(value: LocalizedInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === 'string' && v.length > 0),
  ) as Record<string, string>
}

/**
 * Parquet is tracked with LFS: a git host refuses or chokes on multi-megabyte
 * blobs in normal history, and the server's clone resolves LFS pointers before
 * the app ever sees the tree (`clone_to_zip`). The glob form matches what the
 * app's own export writes, so a repo stays consistent whoever wrote it.
 */
const GITATTRIBUTES = '*.parquet filter=lfs diff=lfs merge=lfs -text\n'

/** Serialize a database. Deterministic: same spec → same bytes. */
export function serializeDatabase(spec: DatabaseSpec): SerializedTree {
  const tables = spec.tables ?? []
  if (!spec.inMemory && tables.length === 0) {
    throw new Error(
      `Database "${spec.id}" declares no tables. Pass tables, or set inMemory: true `
      + 'for a database that is meant to start empty (an ETL target).',
    )
  }

  const seen = new Set<string>()
  for (const table of tables) {
    if (seen.has(table.name)) {
      // Both would land on data/<name>.parquet: the second silently overwrites
      // the first, and the database imports with a table missing.
      throw new Error(`Database "${spec.id}" declares the table "${table.name}" twice.`)
    }
    seen.add(table.name)
  }

  // Sorted so a re-serialization of the same database is byte-stable and the
  // git diff shows only real changes.
  const ordered = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const meta = {
    id: spec.id,
    alias: spec.alias,
    name: localized(spec.name),
    ...(spec.description ? { description: localized(spec.description) } : {}),
    sourceType: 'database',
    schema: typeof spec.schema === 'string'
      ? spec.schema
      : canonicalSchemaMapping(spec.schema),
    tables: ordered.map((t) => t.name),
    ...(spec.inMemory ? { inMemory: true } : {}),
    ...(spec.isVocabularyReference ? { isVocabularyReference: true } : {}),
    version: spec.version ?? '0.1.0',
  }

  const files: WriteFile[] = [{ path: '_database.json', content: json(meta) }]
  const copies: CopyFile[] = ordered.map((t) => ({
    path: `data/${t.name}.parquet`,
    source: t.source,
  }))

  // Only when there is something to track: an empty .gitattributes is noise.
  if (copies.length > 0) files.push({ path: '.gitattributes', content: GITATTRIBUTES })

  return { files, copies }
}
