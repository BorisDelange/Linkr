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

/**
 * Where a database's schema came from — kept alongside the mapping itself.
 *
 * A database **copies** its mapping rather than referencing one (`DataSource
 * .schemaMapping` is the whole mapping, not a foreign key), which is what makes
 * a repo self-contained. But a copy loses provenance: nothing then says which
 * published schema this was, and a UI can only print whatever `presetId` the
 * copied mapping happens to carry.
 *
 * So the provenance travels separately, and it carries **both** halves for the
 * same reason `createdByDetails` sits next to `createdBy`: the id resolves the
 * schema when it is installed, and the snapshot stays readable when it is not.
 * Without the labels a database whose schema was never installed here shows an
 * opaque slug; without the id, two copies of the same schema cannot be told
 * apart across instances.
 */
export interface SchemaProvenance {
  /**
   * Cross-instance identity of the source preset, verbatim from its `lineageId`.
   *
   * Not the preset's `presetId`: that is a local primary key, regenerated on
   * import to keep local uniqueness, so it identifies nothing on another
   * instance. `lineageId` is preserved verbatim precisely so the same schema
   * stays recognizable — see the `Lineaged` mixin.
   */
  lineageId: string
  /** Human-readable name, so the schema stays nameable when it is not installed. */
  label?: LocalizedInput
  /** Author-declared version of the preset this was taken from. */
  version?: string
}

export interface DatabaseSpec {
  /** Stable identity, e.g. `mimic-iv-demo`. Travels across instances. */
  id: string
  /** Short, URL-safe name used as the DuckDB schema name, e.g. `mimic_iv_demo`. */
  alias: string
  name: LocalizedInput
  description?: LocalizedInput
  /**
   * How to read the tables — **the mapping itself**, written inline.
   *
   * A bare string is accepted for convenience while authoring, but it is
   * resolved to a full mapping before writing: the built-in preset table it
   * would otherwise be looked up in is being retired (schemas are installed
   * from the catalog now, not compiled in), so a file holding only a name would
   * stop resolving. Inline also makes the repo installable in any order.
   */
  schema: string | Record<string, unknown>
  /** Which published schema this mapping came from. See `SchemaProvenance`. */
  schemaSource?: SchemaProvenance
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

  if (typeof spec.schema === 'string') {
    // Writing a bare name would produce a file that only resolves against the
    // built-in preset table — which is being retired, since schemas are
    // installed from the catalog now rather than compiled into the app. The
    // repo has to carry the mapping to stay readable.
    throw new Error(
      `Database "${spec.id}" declares its schema as the name "${spec.schema}". `
      + 'Pass the full mapping instead: a name only resolves against presets installed '
      + 'on the importing instance, so the repo would not be self-contained. '
      + 'Read the mapping from the schema preset repo and inline it, recording where it '
      + 'came from in `schemaSource`.',
    )
  }

  const source = spec.schemaSource
  const meta = {
    id: spec.id,
    alias: spec.alias,
    name: localized(spec.name),
    ...(spec.description ? { description: localized(spec.description) } : {}),
    sourceType: 'database',
    schema: canonicalSchemaMapping(spec.schema),
    ...(source
      ? {
        schemaSource: {
          lineageId: source.lineageId,
          ...(source.label ? { label: localized(source.label) } : {}),
          ...(source.version ? { version: source.version } : {}),
        },
      }
      : {}),
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
