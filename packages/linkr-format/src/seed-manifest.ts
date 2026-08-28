/**
 * Build the seed manifest the app's seed loader reads.
 *
 * `apps/web/public/data/seed/<workspace>/manifest.json` is not part of the export
 * format: it is an *index over* an exported workspace tree, telling the loader
 * which entities to seed and in what shape. Two producers need it and they had
 * drifted into two implementations:
 *
 *   - `linkr-portal`'s `build.sh` (~300 lines of bash), for a portal deployment;
 *   - `scripts/fetch-default-data.mjs`, for this repo's own bundled default data.
 *
 * So the rule lives here, pure and over `EntityTree`, and both call it. Same
 * reasoning as the rest of this package: one description of the format, testable
 * without a filesystem, usable from Node and the browser alike.
 *
 * What it does NOT do: fetch, clone, copy files, or resolve git links. The caller
 * assembles the tree — splicing each git-linked child's repo over its pointer —
 * and hands the finished thing here to be indexed.
 *
 * See docs/planning/default-data-repos-plan.md §0.
 */

import { ENTITY_MANIFEST, MANIFEST } from './layout.js'
import { filesIn, readJson, type EntityTree } from './tree.js'

/** Entity kinds the loader re-seeds individually, each with its own guard flag. */
export type SeedEntityKind =
  | 'project'
  | 'mappingProject'
  | 'dqRuleSet'
  | 'catalog'
  | 'database'
  | 'etlPipeline'

/** One entry in `manifest.json`'s `entities[]`. Extra per-kind keys ride along. */
export interface SeedManifestEntity {
  type: SeedEntityKind
  /** Stable per-entity key: the folder name. Keys the guard flag and the hash. */
  id: string
  folder?: string
  /** Flat pre-folder form (`data-quality/<id>.json`), still read by the loader. */
  path?: string
  [extra: string]: unknown
}

/** Bootstrap content the loader writes once and never re-seeds. */
export interface SeedInternals {
  schemas?: string[]
  databases?: string[]
  wikiPages?: string[]
  conceptSets?: string[]
  serviceMappings?: string[]
  sqlCollections?: string[]
  sqlScriptFiles?: Record<string, string>
  etlPipelines?: string[]
  etlFiles?: Record<string, string>
  pluginFolders?: string[]
  pluginFiles?: Record<string, string[]>
}

export interface SeedManifest {
  schemaVersion: 2
  organization?: unknown
  entities: SeedManifestEntity[]
  internals?: SeedInternals
}

export interface BuildSeedManifestOptions {
  /** Organization record to stamp into the manifest, when the caller has one. */
  organization?: unknown
  /**
   * Public URL prefix the seeded tree is served from, e.g. `/data/seed/default`.
   *
   * A database repo carries its Parquet in `databases/<folder>/data/`, but the
   * loader fetches over HTTP and so needs the URL, not the disk path. Given this,
   * `parquetBase` and `tables` are DERIVED from the tree — never hand-listed, so
   * they cannot drift from what the repo actually ships.
   */
  seedBaseUrl?: string
  /**
   * Per-database extras that genuinely cannot be derived — today only
   * `linkToProject`.
   *
   * `linkedDataSourceIds` is stripped from every export as an instance field
   * ("databases stay unlinked"), which is right for a user's import and wrong for
   * a seed meant to open ready to use. So the seed re-states that one link, and
   * only that one.
   *
   * Deliberately NOT a place to patch up broken cross-entity links: a pipeline's
   * source/target/mapping ids are an export bug with its own fix
   * (docs/planning/portable-entity-links-plan.md). Hand-maintaining them here
   * would hide the bug and rot at the next re-export.
   *
   * Keyed by database folder name.
   */
  databases?: Record<string, Record<string, unknown>>
}

/** Folder names directly under `dir/` that contain at least one file. */
function foldersIn(tree: EntityTree, dir: string): string[] {
  const prefix = `${dir}/`
  const names = new Set<string>()
  for (const p of tree.paths()) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) names.add(rest.slice(0, slash))
  }
  return [...names].sort()
}

/**
 * The manifest present in `dir`, or null when the folder is not an entity.
 *
 * `entity.json` first, then the kind's retired name: a repo published before the
 * rename still has to index, and both names stay readable forever.
 */
function manifestIn(tree: EntityTree, dir: string, legacy: string[]): string | null {
  for (const name of [ENTITY_MANIFEST, ...legacy]) {
    if (tree.read(`${dir}/${name}`) != null) return name
  }
  return null
}

/** Every file under `dir/`, as `<name>/<rel>` → `<rel>`, minus the manifests. */
function treeFiles(tree: EntityTree, dir: string, name: string, legacy: string[]): Record<string, string> {
  const skip = new Set([ENTITY_MANIFEST, '_tree.json', ...legacy])
  const prefix = `${dir}/`
  const out: Record<string, string> = {}
  for (const p of tree.paths().slice().sort()) {
    if (!p.startsWith(prefix)) continue
    const rel = p.slice(prefix.length)
    if (skip.has(rel)) continue
    out[`${name}/${rel}`] = rel
  }
  return out
}

/**
 * Index an assembled workspace tree into the loader's manifest.
 *
 * Order within `entities[]` is the declaration order the loader replays, so it is
 * kept stable (folder name, per kind) rather than left to filesystem order — a
 * manifest that reshuffles on every build would churn the seed hashes and make the
 * app announce a "default data update" that changed nothing.
 */
export function buildSeedManifest(
  tree: EntityTree,
  options: BuildSeedManifestOptions = {},
): SeedManifest {
  const entities: SeedManifestEntity[] = []
  const internals: SeedInternals = {}

  // --- projects/ ---
  for (const folder of foldersIn(tree, 'projects')) {
    if (!manifestIn(tree, `projects/${folder}`, [MANIFEST.project])) continue
    entities.push({ type: 'project', id: folder, folder })
  }

  // --- mapping-projects/ ---
  for (const folder of foldersIn(tree, 'mapping-projects')) {
    // `_project.json` predates the rename to `project.json`; both still resolve.
    if (!manifestIn(tree, `mapping-projects/${folder}`, [MANIFEST.project, '_project.json'])) continue
    entities.push({ type: 'mappingProject', id: folder, folder })
  }

  // --- data-quality/ and catalogs/: a folder now, a flat file before ---
  for (const [dir, kind, legacy] of [
    ['data-quality', 'dqRuleSet', MANIFEST['dq-rule-set']],
    ['catalogs', 'catalog', MANIFEST['data-catalog']],
  ] as const) {
    for (const file of filesIn(tree, dir, '.json')) {
      const name = file.slice(dir.length + 1)
      entities.push({ type: kind, id: name.replace(/\.json$/, ''), path: `${dir}/${name}` })
    }
    for (const folder of foldersIn(tree, dir)) {
      const manifest = manifestIn(tree, `${dir}/${folder}`, [legacy])
      if (!manifest) continue
      entities.push({ type: kind, id: folder, path: `${dir}/${folder}/${manifest}` })
    }
  }

  // --- databases/: a database becomes a seedable entity only when the repo
  //     actually ships rows (`data/*.parquet`). Without them there is nothing to
  //     mount, so it stays metadata in internals and the workspace import writes
  //     the row like any other pointer. ---
  const dbInternals: string[] = []
  for (const folder of foldersIn(tree, 'databases')) {
    const dir = `databases/${folder}`
    const manifest = manifestIn(tree, dir, [MANIFEST.database])
    if (!manifest) continue
    dbInternals.push(`${dir}/${manifest}`)

    // Derived, never declared: the tables ARE the Parquet files present, so this
    // cannot drift from what the repo ships the way a hand-kept list would.
    const tables = tree
      .paths()
      .filter((p) => p.startsWith(`${dir}/data/`) && p.endsWith('.parquet'))
      .map((p) => p.slice(`${dir}/data/`.length).replace(/\.parquet$/, ''))
      .filter((t) => !t.includes('/'))
      .sort()
    if (!tables.length || !options.seedBaseUrl) continue

    const meta = readJson<Record<string, unknown>>(tree, `${dir}/${manifest}`)
    const declared = meta.ok ? (meta.value as Record<string, unknown>) : {}
    entities.push({
      type: 'database',
      // Must match the row the workspace import wrote, which keys on the
      // manifest's own entityId — not on the folder name.
      id: String(declared.entityId ?? declared.id ?? folder),
      alias: declared.alias ?? folder,
      name: declared.name ?? folder,
      ...(declared.description ? { description: declared.description } : {}),
      ...(declared.schemaMapping ? { schema: declared.schemaMapping } : {}),
      ...(declared.isVocabularyReference ? { isVocabularyReference: true } : {}),
      parquetBase: `${options.seedBaseUrl.replace(/\/$/, '')}/${dir}/data`,
      tables,
      ...options.databases?.[folder],
    })
  }
  // Flat pre-folder form: the whole row in one file.
  for (const file of filesIn(tree, 'databases', '.json')) dbInternals.push(file)
  if (dbInternals.length) internals.databases = dbInternals.sort()

  // --- schemas/ → internals ---
  const schemas: string[] = [...filesIn(tree, 'schemas', '.json')]
  for (const folder of foldersIn(tree, 'schemas')) {
    const manifest = manifestIn(tree, `schemas/${folder}`, [MANIFEST['schema-preset']])
    if (manifest) schemas.push(`schemas/${folder}/${manifest}`)
  }
  if (schemas.length) internals.schemas = schemas.sort()

  // --- etl/ and sql-scripts/ → internals, with their file trees ---
  for (const [dir, listKey, filesKey, legacy] of [
    ['etl', 'etlPipelines', 'etlFiles', MANIFEST['etl-pipeline']],
    ['sql-scripts', 'sqlCollections', 'sqlScriptFiles', MANIFEST['sql-collection']],
  ] as const) {
    const list: string[] = []
    let files: Record<string, string> = {}
    for (const folder of foldersIn(tree, dir)) {
      if (!manifestIn(tree, `${dir}/${folder}`, [legacy])) continue
      list.push(folder)
      files = { ...files, ...treeFiles(tree, `${dir}/${folder}`, folder, [legacy]) }
    }
    if (list.length) internals[listKey] = list
    if (Object.keys(files).length) internals[filesKey] = files
  }

  // --- flat JSON lists → internals ---
  for (const [dir, key] of [
    ['concept-sets', 'conceptSets'],
    ['service-mappings', 'serviceMappings'],
  ] as const) {
    const found = filesIn(tree, dir, '.json')
    if (found.length) internals[key] = found
  }

  // --- wiki/: only with its tree index, which is what the loader reads first ---
  if (tree.read('wiki/_tree.json') != null) {
    const pages = filesIn(tree, 'wiki', '.md')
    if (pages.length) internals.wikiPages = pages
  }

  // --- plugins/ → internals. `plugin.json` is the plugin's own functional
  //     manifest, not entity metadata, so it stays in the file list. ---
  const pluginFolders: string[] = []
  const pluginFiles: Record<string, string[]> = {}
  for (const folder of foldersIn(tree, 'plugins')) {
    const manifest = manifestIn(tree, `plugins/${folder}`, [MANIFEST['user-plugin']])
    if (!manifest) continue
    pluginFolders.push(folder)
    const prefix = `plugins/${folder}/`
    pluginFiles[folder] = tree
      .paths()
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .filter((rel) => !rel.includes('/') && rel !== ENTITY_MANIFEST && rel !== MANIFEST['user-plugin'])
      .sort()
  }
  if (pluginFolders.length) {
    internals.pluginFolders = pluginFolders
    internals.pluginFiles = pluginFiles
  }

  return {
    schemaVersion: 2,
    ...(options.organization ? { organization: options.organization } : {}),
    entities,
    ...(Object.keys(internals).length ? { internals } : {}),
  }
}

/** Root `seed.json`: the list of workspace folders the loader walks. */
export function buildSeedRoot(workspaces: string[]): { schemaVersion: 2; workspaces: string[] } {
  return { schemaVersion: 2, workspaces: [...workspaces].sort() }
}
