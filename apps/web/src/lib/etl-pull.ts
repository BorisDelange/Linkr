/**
 * Pull orchestration for an ETL pipeline — the additive-overlay model, as for
 * projects (`project-pull.ts`), not the mapping-project 3-way merge.
 *
 * An ETL pipeline is a pure file tree (`_pipeline.json` + `_tree.json` + the
 * files at their real paths), which makes it the simplest case: the natural key
 * of every item IS its path, so no name-slug reconciliation is needed. We clone
 * the remote to a ZIP, read the tree, and let the user pick per group what to
 * bring in.
 *
 * Groups are the SAME vocabulary the push side already uses — the categories of
 * `gitFileMeta('etl-pipelines', path)`: scripts (.sql/.py/.r) and mappings
 * (mapping/*.csv), plus the pipeline settings from `_pipeline.json` as a single
 * block toggle. A hand-written enum (as `ProjectPullGroup` is) would have let
 * push and pull drift apart over the same paths.
 *
 * A pulled `mapping/*.csv` is marked as a versioned data file on the way in:
 * data is gitignored by default, so without the mark the file would read as an
 * untracked local change the moment it landed.
 */
import type { EtlFile, EtlPipeline } from '@/types'
import type { Storage } from '@/lib/storage'
import { getStorage } from '@/lib/storage'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { gitFileMeta } from '@/lib/git-file-meta'
import { treeNodePath } from '@/lib/entity-tree'
import {
  attachTreeIds,
  dropForeignAuthorId,
  isEntityDocsFile,
  parseImportZip,
  reconstructTreeFiles,
  stripInstanceFields,
  type TreeImportNode,
} from '@/lib/entity-io'
import {
  entityDocsChanged,
  entityDocsChanges,
  readEntityDocsFrom,
  type EntityDocs,
} from '@/lib/entity-docs-pull'
import { setVersionedMany } from '@/features/warehouse/etl/etl-versioning'

/** Pullable groups of an ETL pipeline, in display order. */
export type EtlPullGroup = 'scripts' | 'mappings' | 'other'

export const ETL_PULL_GROUPS: EtlPullGroup[] = ['scripts', 'mappings', 'other']

/** One remote file the user can choose to pull. */
export interface EtlPullItem {
  /** The export-tree path — the natural key, and the selection id. */
  key: string
  /** True when a local file already exists at this path → pulling OVERWRITES it. */
  exists: boolean
}

export interface EtlPullPlan {
  /** Files by group; only non-empty groups are shown. */
  groups: Record<EtlPullGroup, EtlPullItem[]>
  /** The remote pipeline settings differ from the local ones (a single block). */
  settingsChanged: boolean
  /**
   * The remote README / LICENSE differ from the local ones (a single block).
   *
   * These are NOT tree files: the export writes `README.md` / `LICENSE.md` beside
   * `_tree.json` and the entity owns them as `readme` / `license` fields. Planning
   * only from `_tree.json` therefore missed them entirely — a remote commit that
   * added a README reported "nothing to pull".
   */
  docsChanged: boolean
}


export interface PreparedEtlPull {
  plan: EtlPullPlan
  /** Remote tree nodes carrying their path and content — what a pull applies. */
  nodes: TreeImportNode[]
  /** Remote `_pipeline.json`, minus instance-local fields. */
  remotePipeline: Partial<EtlPipeline> | null
  /** Remote README / LICENSE, read from the files beside the manifests. */
  remoteDocs: EntityDocs
  /** The commit the clone landed on — the sync anchor after a successful pull. */
  clonedOid: string | null
  branch: string
}

export interface EtlPullSelection {
  /** Chosen paths across all groups (the group is only a UI grouping). */
  paths: Set<string>
  /** Replace the local pipeline settings with the remote ones. */
  settings: boolean
  /** Replace the local README / license with the remote ones. */
  docs: boolean
}

/**
 * Which group a path belongs to.
 *
 * Delegates to the push-side classifier so one path is never called "scripts" on
 * one screen and something else on the other.
 */
export function etlPullGroupOf(path: string): EtlPullGroup {
  const category = gitFileMeta('etl-pipelines', path).category
  if (category === 'scripts') return 'scripts'
  if (category === 'mappings') return 'mappings'
  return 'other'
}

/**
 * Paths a pull must not offer as individual file items.
 *
 * Manifests and git config are machinery. The docs files (README/LICENSE/
 * attachments) are excluded for a different reason: the entity OWNS them as
 * `readme`/`license` fields — they are not tree nodes — so they travel as the
 * docs block instead. `isEntityDocsFile` is the export's own predicate, reused
 * here so the two sides cannot disagree on what counts as a docs file.
 */
export function isEtlManifest(path: string): boolean {
  return path === '_pipeline.json' || path === '_tree.json'
    || path === '.gitignore' || path === '.gitattributes'
    || isEntityDocsFile(path)
}

/**
 * Pipeline fields a pull must NOT take, on top of the shared export list
 * (`stripInstanceFields`, which already drops workspaceId, gitRemoteConfig,
 * organization, updatedAt, createdById…).
 *
 * These are what a real `_pipeline.json` turned out to carry — the export writes
 * them, so the pull is what has to refuse them:
 *   - the data source ids name databases on THIS instance; taking a collaborator's
 *     would repoint the pipeline at a database that does not exist here
 *   - mappingProjectId likewise names a local mapping project
 *   - lastRunAt / lastRunDurationMs / status describe OUR runs, not theirs;
 *     importing them would show a run that never happened here (and the quality
 *     cache keys on the last run, so it would also invalidate itself)
 *   - id / entityId / lineageId are identity, resolved locally
 */
const EXTRA_INSTANCE_PIPELINE_FIELDS = [
  'id', 'entityId', 'sourceDataSourceId', 'targetDataSourceId', 'mappingProjectId',
  'lastRunAt', 'lastRunDurationMs', 'status', 'createdAt',
] as const

/** Local files as a path → file map, paths derived by walking `parentId`. */
export function etlFilesByPath(files: EtlFile[]): Map<string, EtlFile> {
  const byId = new Map(files.map((f) => [f.id, f]))
  const out = new Map<string, EtlFile>()
  for (const f of files) {
    if (f.type !== 'file') continue
    out.set(treeNodePath(f, byId), f)
  }
  return out
}

/**
 * Path of each freshly-derived record, by its id.
 *
 * `attachTreeIds` returns storable nodes with `path` stripped, so the path is
 * rebuilt from the records' own hierarchy — the same walk `etlFilesByPath` does
 * on the local rows, which is what makes the two sides comparable.
 */
export function etlRecordPaths(records: EtlFile[]): Map<string, string> {
  const byId = new Map(records.map((r) => [r.id, r]))
  return new Map(records.map((r) => [r.id, treeNodePath(r, byId)]))
}

/**
 * Build the pull plan from remote tree nodes and the local files.
 *
 * Only files the user can DO something about are listed: a file whose content is
 * already byte-identical to the remote is dropped, not shown greyed out. A
 * pipeline repo is dozens of scripts and a pull typically touches one or two, so
 * listing the rest buried the real changes and pushed the dialog past its own
 * footer. "Nothing to pull" is then simply an empty plan.
 *
 * Pure, so the grouping and the new/overwrite marking are testable without a
 * git remote.
 */
export function buildEtlPullPlan(
  nodes: TreeImportNode[],
  localFiles: EtlFile[],
  settingsChanged: boolean,
  docsChanged = false,
): EtlPullPlan {
  const localByPath = etlFilesByPath(localFiles)
  const groups: Record<EtlPullGroup, EtlPullItem[]> = { scripts: [], mappings: [], other: [] }
  for (const node of nodes) {
    if (node.type !== 'file' || isEtlManifest(node.path)) continue
    const local = localByPath.get(node.path)
    if (local && (local.content ?? '') === (node.content ?? '')) continue
    groups[etlPullGroupOf(node.path)].push({ key: node.path, exists: !!local })
  }
  for (const key of ETL_PULL_GROUPS) {
    groups[key].sort((a, b) => a.key.localeCompare(b.key))
  }
  return { groups, settingsChanged, docsChanged }
}

/** Do the remote pipeline settings differ from the local ones? */
export function etlSettingsChanged(
  local: EtlPipeline | undefined,
  remote: Partial<EtlPipeline> | null,
): boolean {
  if (!remote) return false
  const norm = (v: unknown) => JSON.stringify(v ?? null)
  // Only the fields a pull would actually write. Comparing the whole record would
  // flag `updatedAt` on every fetch and leave the toggle permanently lit.
  return (
    norm(local?.name) !== norm(remote.name)
    || norm(local?.description) !== norm(remote.description)
    || norm(local?.config) !== norm(remote.config)
  )
}

/**
 * Strip the fields that belong to this instance rather than to the repo.
 *
 * Delegates to the shared `stripInstanceFields` so the pull and the export agree
 * on what is instance-local, then removes the pipeline-specific extras above.
 */
export function stripInstancePipelineFields(remote: EtlPipeline): Partial<EtlPipeline> {
  const copy = stripInstanceFields(dropForeignAuthorId(remote)) as Record<string, unknown>
  for (const field of EXTRA_INSTANCE_PIPELINE_FIELDS) delete copy[field]
  return copy as Partial<EtlPipeline>
}

/** Clone the pipeline's linked remote and diff it against the local files. */
export async function prepareEtlPull(
  pipelineId: string,
  branch: string,
): Promise<PreparedEtlPull> {
  const storage = getStorage()
  const pipeline = await storage.etlPipelines.getById(pipelineId)
  const url = pipeline?.gitRemoteConfig?.url
  if (!url) throw new Error('Pipeline is not linked to a git remote')

  const cloned = await gitCloneToZip(cleanGitUrl(url), branch)
  const parsed = await parseImportZip(new File([cloned.blob], 'pull.zip'))

  const tree = parsed['_tree.json']
  if (!tree) throw new Error('Cloned repository is not a valid ETL pipeline export')
  const nodes = reconstructTreeFiles(tree, parsed)

  const rawRemote = parsed['_pipeline.json'] as EtlPipeline | undefined
  const remotePipeline = rawRemote ? stripInstancePipelineFields(rawRemote) : null
  // Docs come from the FILES beside the manifests, not from _tree.json — the
  // entity owns them. The license id is in the JSON, its text in LICENSE.md.
  const remoteDocs = readEntityDocsFrom(parsed, rawRemote ?? null)

  const localFiles = await storage.etlFiles.getByPipeline(pipelineId)

  return {
    plan: buildEtlPullPlan(
      nodes,
      localFiles,
      etlSettingsChanged(pipeline, remotePipeline),
      entityDocsChanged(pipeline, remoteDocs),
    ),
    nodes,
    remotePipeline,
    remoteDocs,
    clonedOid: cloned.oid,
    branch,
  }
}

/**
 * Apply the resolved pull: write the chosen files (replacing the local ones at
 * the same paths), optionally the pipeline settings, then advance the sync anchor.
 *
 * Ids are derived from (pipelineId, path) exactly as on import, so a pulled file
 * lands on the id it would have had on a fresh clone — the determinism that keeps
 * run history and versioning marks attached to it.
 */
export async function applyEtlPull(
  pipelineId: string,
  prepared: PreparedEtlPull,
  selection: EtlPullSelection,
  storage: Storage = getStorage(),
): Promise<void> {
  const { nodes, remotePipeline, branch, clonedOid } = prepared

  const chosen = nodes.filter((n) => n.type === 'file' && selection.paths.has(n.path))
  if (chosen.length > 0) {
    const localByPath = etlFilesByPath(await storage.etlFiles.getByPipeline(pipelineId))
    // Records come back in the SAME order they went in (attachTreeIds maps over
    // the array), but with `path` stripped and folders synthesized ahead of their
    // children — so the path is recovered by name-matching rather than by index.
    // Matching on the local row's PATH, not on a derived id: a file the user
    // created here has a random id, only imported ones are deterministic.
    const records = attachTreeIds<EtlFile>(chosen, pipelineId, 'pipelineId')
    const pathOfRecord = etlRecordPaths(records)

    for (const node of records) {
      const path = pathOfRecord.get(node.id)
      const existing = path ? localByPath.get(path) : undefined
      if (existing) {
        // Update rather than delete+create: deleting would drop whatever else
        // references the row, and a local file keeps its own (random) id.
        await storage.etlFiles.update(existing.id, { content: node.content }).catch(() => {})
      } else {
        await storage.etlFiles.create(dropForeignAuthorId(node) as EtlFile).catch(() => {})
      }
    }
  }

  // Pulled mapping CSVs must be marked for versioning, or they land gitignored
  // and immediately read as an untracked local change.
  const pulledData = [...selection.paths].filter((p) => etlPullGroupOf(p) === 'mappings')
  if (pulledData.length > 0) {
    const fresh = await storage.etlPipelines.getById(pipelineId)
    if (fresh) {
      await storage.etlPipelines.update(pipelineId, {
        config: setVersionedMany(pulledData, true, fresh.config),
      }).catch(() => {})
    }
  }

  if (selection.settings && remotePipeline) {
    await storage.etlPipelines.update(pipelineId, remotePipeline).catch(() => {})
  }

  // Docs are entity fields, written whether or not the settings block was taken.
  // Only what the remote actually carries is written: a repo with a README but no
  // LICENSE must not blank out a local license.
  if (selection.docs) {
    const changes = entityDocsChanges(prepared.remoteDocs)
    if (Object.keys(changes).length > 0) {
      await storage.etlPipelines.update(pipelineId, changes).catch(() => {})
    }
  }

  // Now in sync with the cloned commit — anchor to it so the behind/diverged
  // banner clears (server mode only; front-only has no anchor to set).
  if (clonedOid) {
    await gitSetSyncState('etl-pipelines', pipelineId, branch, clonedOid).catch(() => {})
  }
}
