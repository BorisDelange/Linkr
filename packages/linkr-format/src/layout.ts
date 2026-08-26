/**
 * Where things live in an exported entity tree — the single source of truth.
 *
 * Every filename in the export format used to be a bare string literal, retyped
 * in the reader, the writer, the kind detector and the human-readable error text
 * (`project.json` alone had 8 sites in `entity-io.ts` and 6 here). That is not a
 * tidiness problem: the lists had already drifted apart. `node/cli.ts` told a user
 * their database repo was "not a Linkr entity tree" while the MCP server accepted
 * it, because one prose list had been updated and the other had not.
 *
 * Import from here instead of retyping. Three consumers cannot:
 *   - the Python export twin (`apps/api/app/services/workspace_export*.py`), kept
 *     in step by hand and guarded by the export golden tests;
 *   - `linkr-catalog`'s `scan.mjs` and `linkr-portal`'s `build.sh`, which live in
 *     other repos entirely — and whose CI runs on a bare node/bash with no install,
 *     so they restate ENTITY_MANIFEST and the legacy names with a pointer back here.
 * All three are noted in docs/planning/export-format-harmonization-plan.md.
 */

/** Every entity kind that has a standalone export tree. */
export type LayoutKind =
  | 'project'
  | 'workspace'
  | 'mapping-project'
  | 'sql-collection'
  | 'etl-pipeline'
  | 'schema-preset'
  | 'dq-rule-set'
  | 'data-catalog'
  | 'user-plugin'
  | 'database'

/**
 * The manifest at the root of each kind's tree.
 *
 * Insertion order is load-bearing: `detectEntityKind` walks it in order, and
 * `mappings.json` must be tried before `project.json` — a mapping project has
 * both, and only the first distinguishes it from a plain project.
 */
export const MANIFEST: Record<LayoutKind, string> = {
  'mapping-project': 'mappings.json',
  'sql-collection': '_collection.json',
  'etl-pipeline': '_pipeline.json',
  'schema-preset': 'preset.json',
  'dq-rule-set': 'rule-set.json',
  'data-catalog': 'catalog.json',
  'database': '_database.json',
  'project': 'project.json',
  'workspace': 'workspace.json',
  'user-plugin': '_plugin.json',
}

/**
 * The one manifest name every entity is moving to.
 *
 * Readers accept it *and* the per-kind name in MANIFEST; writers still emit the
 * old names until the format flip. Being tolerant here is a few lines in one
 * place, and it is what lets every already-published repo keep working forever.
 */
export const ENTITY_MANIFEST = 'entity.json'

/**
 * `entity.json`'s own declaration of what it is.
 *
 * Kind detection is a filename lookup today, which cannot survive one shared
 * manifest name — and it already needs a special case (`mappings.json` is what
 * tells a mapping project from a plain project). An explicit field replaces the
 * heuristic rather than moving it. The vocabulary is deliberately the catalog
 * entry schema's `type`, so the two never need translating.
 */
export const ENTITY_TYPES: readonly LayoutKind[] = [
  'project', 'workspace', 'mapping-project', 'sql-collection', 'etl-pipeline',
  'schema-preset', 'dq-rule-set', 'data-catalog', 'user-plugin', 'database',
] as const

/** Whether a value is one of the declared entity types. */
export function isEntityType(value: unknown): value is LayoutKind {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)
}

/**
 * Candidate manifest names for a kind, newest first.
 *
 * The single place that knows a tree may carry either name. Readers map over it;
 * writers pick `MANIFEST[kind]` until the flip, then `ENTITY_MANIFEST`.
 */
export function manifestCandidates(kind: LayoutKind): string[] {
  return [ENTITY_MANIFEST, MANIFEST[kind]]
}

/**
 * The folder an entity's user-authored file tree lives in.
 *
 * ETL pipelines and SQL collections used to scatter their files across the repo
 * root, which is why their `_tree.json` had to sit at the root too — there was no
 * single folder for it to describe. Giving them the same container a project's
 * scripts already use puts the sidecar back beside the files it describes, and
 * makes "where does code live in a Linkr entity?" answerable once.
 *
 * A pipeline's `mapping/` is NOT part of this: it is machine-managed (see
 * MAPPING_DIR in the app), holds generated vocabulary CSVs the ETL scripts read
 * by path, and stays a sibling at the root.
 */
export const SCRIPTS_DIR = 'scripts'

/**
 * Sidecars: machine-written files describing the files beside them. Never a
 * manifest — that distinction is what the leading `_` is for.
 */
export const SIDECAR = {
  /** Ordering + per-file metadata for a folder of user files. */
  tree: '_tree.json',
  /** Attachment index next to the blobs it describes. */
  attachmentMeta: '_meta.json',
} as const

/** Files that are content, not metadata, and are read by name. */
export const CONTENT_FILE = {
  /** A schema preset's DDL, split out so a type change is a readable diff. */
  schemaDdl: 'schema.ddl',
  /**
   * A schema preset's table/column mapping.
   *
   * Split out for the same reason as the DDL: it was 83% of the manifest, which
   * buried the identity a human (and the catalog scanner) opens the file for.
   * `entity.json` carries identity + provenance; substantial payload lives beside it.
   */
  schemaMapping: 'mapping.json',
  /** A DQ rule set's checks. */
  dqChecks: 'checks.json',
  /** A plugin's own functional manifest — NOT Linkr entity metadata. */
  pluginManifest: 'plugin.json',
  /** A mapping project's source dictionary. */
  sourceConcepts: 'source-concepts.csv',
} as const

/** Files describing the export as a whole rather than one folder's contents. */
export const ROOT_FILE = {
  /** The publishing organization, one per export. */
  organization: 'organization.json',
  /** Index of git-linked entities; the portal derives .gitmodules from it. */
  gitLinks: 'git-links.json',
  readme: 'README.md',
  license: 'LICENSE.md',
  gitignore: '.gitignore',
  gitattributes: '.gitattributes',
} as const

/**
 * Manifest names as a sentence, for "this is not a Linkr entity tree" errors.
 * Derived, so an error message can never fall behind the table above.
 */
export function manifestList(): string {
  const names = [...new Set(Object.values(MANIFEST))]
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/**
 * Script languages a file extension maps to, shared by every writer.
 * `markdown` is documentation only — the run filters select executable languages.
 */
export const SCRIPT_LANGUAGE: Record<string, string> = {
  py: 'python',
  r: 'r',
  sql: 'sql',
  md: 'markdown',
}

/** The language for a path, or undefined when the extension is not a script. */
export function scriptLanguage(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return SCRIPT_LANGUAGE[ext]
}
