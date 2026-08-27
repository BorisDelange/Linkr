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
import type { EtlFile, EtlPipeline, LocalizedString } from '@/types'
import type { Storage } from '@/lib/storage'
import { getStorage } from '@/lib/storage'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { gitFileMeta } from '@/lib/git-file-meta'
import { README_FILE_RE, treeNodePath } from '@/lib/entity-tree'
import { ENTITY_MANIFEST, MANIFEST, SCRIPTS_DIR, SIDECAR } from '@linkr/format'
import {
  attachTreeIds,
  dropForeignAuthorId,
  isEntityDocsFile,
  parseImportZip,
  readImportedManifest,
  readImportedTree,
  reconstructTreeFiles,
  stripInstanceFields,
  type TreeImportNode,
} from '@/lib/entity-io'
import {
  presentReadme,
  readEntityDocsFrom,
  type DocsOwner,
  type EntityDocs,
} from '@/lib/entity-docs-pull'
import { setVersionedMany } from '@/lib/entity-versioning'

/** Pullable groups of an ETL pipeline, in display order. */
export type EtlPullGroup = 'docs' | 'scripts' | 'mappings' | 'other'

/** Docs first: they are prose the user reads, before the code. */
export const ETL_PULL_GROUPS: EtlPullGroup[] = ['docs', 'scripts', 'mappings', 'other']

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
}


export interface PreparedEtlPull {
  plan: EtlPullPlan
  /** Remote tree nodes carrying their path and content — what a pull applies. */
  nodes: TreeImportNode[]
  /** Remote `_pipeline.json`, minus instance-local fields. */
  remotePipeline: Partial<EtlPipeline> | null
  /** Remote README / LICENSE, read from the files beside the manifests. */
  remoteDocs: EntityDocs
  /** Local files by tree path — the "mine" side of a file's diff. */
  localByPath: Map<string, EtlFile>
  /** The local pipeline row — the "mine" side of the settings diff. */
  localPipeline: EtlPipeline | undefined
  /** The commit the clone landed on — the sync anchor after a successful pull. */
  clonedOid: string | null
  branch: string
}

export interface EtlPullSelection {
  /**
   * Chosen paths across all groups (the group is only a UI grouping).
   *
   * Docs paths (README*.md / LICENSE.md) are selected here like any other file,
   * even though applying them writes the entity's `readme` / `license` fields
   * rather than a tree row — the user picks files, the apply knows the difference.
   */
  paths: Set<string>
  /** Replace the local pipeline settings with the remote ones. */
  settings: boolean
  /**
   * Deliberate "keep mine": take nothing, but still anchor on the remote commit.
   *
   * Distinct from an empty selection, which is merely an unfinished choice. The
   * user is resolving the divergence in favour of the local content, so the
   * behind banner must clear and the next push carry their version over the
   * remote's. Nothing is written — only the anchor moves.
   */
  keepLocal?: boolean
  /**
   * Every item on offer got an explicit verdict (taken or refused).
   *
   * Set by the inline pull, where refusing is a real act rather than an unfinished
   * selection. It advances the REVIEW cursor only — enough to unblock the push
   * without ever claiming we hold content we declined.
   */
  decided?: boolean
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
  // 'readme' covers README*.md, LICENSE.md and attachments/ in the push-side rules.
  if (category === 'readme') return 'docs'
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
  return path === ENTITY_MANIFEST || path === MANIFEST['etl-pipeline']
    || path === SIDECAR.tree || path === `${SCRIPTS_DIR}/${SIDECAR.tree}`
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
 *   - readme / license are DOCS, not settings: `_pipeline.json` carries only the
 *     licence's id and name, its text living in LICENSE.md beside it. Writing the
 *     manifest's copy would replace a complete local licence with a text-less
 *     stub — the export then omits LICENSE.md (it reads as "deleted" on the next
 *     push) and the licence editor crashes on the missing text. Docs are applied
 *     from `remoteDocs`, which recombines the two halves, and only for the files
 *     the user actually picked.
 */
const EXTRA_INSTANCE_PIPELINE_FIELDS = [
  'id', 'entityId', 'sourceDataSourceId', 'targetDataSourceId', 'mappingProjectId',
  'lastRunAt', 'lastRunDurationMs', 'status', 'createdAt',
  'readme', 'license',
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
  docItems: EtlPullItem[] = [],
): EtlPullPlan {
  const localByPath = etlFilesByPath(localFiles)
  const groups: Record<EtlPullGroup, EtlPullItem[]> = {
    docs: [...docItems], scripts: [], mappings: [], other: [],
  }
  for (const node of nodes) {
    if (node.type !== 'file' || isEtlManifest(node.path)) continue
    // A node the tree declares but the repo has no blob for is nothing to pull.
    // Exports before the tree/gitignore fix listed unmarked data files (which are
    // gitignored, so never committed), and the pull offered them as new files that
    // could never arrive — "Mapping files (1)" for a phantom. Tolerated here rather
    // than only fixed in the export, because those trees are already committed in
    // people's repos and must stop lying without needing a fresh push.
    if (node.content == null) continue
    const local = localByPath.get(node.path)
    if (local && (local.content ?? '') === (node.content ?? '')) continue
    groups[etlPullGroupOf(node.path)].push({ key: node.path, exists: !!local })
  }
  for (const key of ETL_PULL_GROUPS) {
    groups[key].sort((a, b) => a.key.localeCompare(b.key))
  }
  return { groups, settingsChanged }
}

/**
 * The docs files a pull can offer, as file items.
 *
 * They are listed as `README.md` / `README.<lang>.md` / `LICENSE.md` because that
 * is what the repository actually contains and what the user recognises — even
 * though applying one writes the entity's `readme` / `license` FIELD rather than a
 * tree row. Each language is its own item, so a French-only change is one row
 * rather than an opaque "readme" block.
 *
 * `exists` means the local entity already has that piece, so pulling replaces it.
 * A piece whose content already matches is omitted, exactly as for scripts.
 */
export function etlDocItems(remote: EntityDocs, local: DocsOwner | undefined): EtlPullItem[] {
  const items: EtlPullItem[] = []
  const localReadme = presentReadme(local?.readme)
  for (const [lang, text] of Object.entries(remote.readme ?? {})) {
    if (!text) continue
    const mine = localReadme?.[lang]
    if (mine === text) continue
    // The primary language is the suffix-free file, mirroring writeReadmeFiles.
    items.push({ key: lang === 'en' ? 'README.md' : `README.${lang}.md`, exists: mine != null })
  }
  if (remote.license?.text && remote.license.text !== local?.license?.text) {
    items.push({ key: 'LICENSE.md', exists: !!local?.license })
  }
  return items
}

/** Map a chosen docs path back to what it writes: a readme language, or the licence. */
export function etlDocTarget(path: string): { readmeLang: string } | 'license' | null {
  if (/^LICENSE\.md$/i.test(path)) return 'license'
  const m = README_FILE_RE.exec(path)
  return m ? { readmeLang: (m[1] ?? 'en').toLowerCase() } : null
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

  const { tree, filePrefix } = readImportedTree(parsed)
  if (!tree) throw new Error('Cloned repository is not a valid ETL pipeline export')
  const nodes = reconstructTreeFiles(tree, parsed, filePrefix)

  const rawRemote = readImportedManifest<EtlPipeline>(parsed, 'etl-pipeline')
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
      etlDocItems(remoteDocs, pipeline),
    ),
    nodes,
    remotePipeline,
    remoteDocs,
    // Keyed by the SAME tree path as the remote nodes, which is what lets the
    // pull show a real before/after for a file it is about to overwrite.
    localByPath: etlFilesByPath(localFiles),
    localPipeline: pipeline,
    clonedOid: cloned.oid,
    branch,
  }
}

/** Every actionable path the plan offers — what a COMPLETE pull would take. */
export function etlPullPlanPaths(plan: EtlPullPlan): Set<string> {
  const out = new Set<string>()
  for (const items of Object.values(plan.groups)) {
    for (const item of items) out.add(item.key)
  }
  return out
}

/**
 * Did this selection take everything the plan offered?
 *
 * The anchor may only advance for a COMPLETE pull: it means "the content of this
 * commit is what we hold". Taking three of five files and then claiming the
 * commit hides the other two for good — the behind banner clears and the plan is
 * rebuilt against the new anchor, so they are never offered again.
 */
export function isCompleteEtlPull(plan: EtlPullPlan, selection: EtlPullSelection): boolean {
  if (plan.settingsChanged && !selection.settings) return false
  for (const path of etlPullPlanPaths(plan)) {
    if (!selection.paths.has(path)) return false
  }
  return true
}

/**
 * Apply the resolved pull: write the chosen files (replacing the local ones at
 * the same paths), optionally the pipeline settings, then advance the sync anchor
 * — but only when the pull was COMPLETE and every write succeeded.
 *
 * Ids are derived from (pipelineId, path) exactly as on import, so a pulled file
 * lands on the id it would have had on a fresh clone — the determinism that keeps
 * run history and versioning marks attached to it.
 *
 * Throws when a write failed. Every write used to be `.catch(() => {})`, so this
 * resolved successfully after a TOTAL failure and anchored anyway — which also
 * made the dialog's rollback ("leave the banner up rather than claim a sync we
 * failed to record") unreachable.
 */
export async function applyEtlPull(
  pipelineId: string,
  prepared: PreparedEtlPull,
  selection: EtlPullSelection,
  storage: Storage = getStorage(),
): Promise<void> {
  const { nodes, remotePipeline, remoteDocs, branch, clonedOid, plan } = prepared
  // Collected, not swallowed: a failed row must not read as a successful pull.
  let failed = false
  const track = async (op: Promise<unknown>): Promise<void> => {
    try {
      await op
    } catch (e) {
      failed = true
      console.warn('[etl-pull] write failed:', e)
    }
  }

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
        await track(storage.etlFiles.update(existing.id, { content: node.content }))
      } else {
        await track(storage.etlFiles.create(dropForeignAuthorId(node) as EtlFile))
      }
    }
  }

  // Pulled mapping CSVs must be marked for versioning, or they land gitignored
  // and immediately read as an untracked local change.
  const pulledData = [...selection.paths].filter((p) => etlPullGroupOf(p) === 'mappings')
  if (pulledData.length > 0) {
    const fresh = await storage.etlPipelines.getById(pipelineId)
    if (fresh) {
      await track(storage.etlPipelines.update(pipelineId, {
        config: setVersionedMany(pulledData, true, fresh.config),
      }))
    }
  }

  if (selection.settings && remotePipeline) {
    await track(storage.etlPipelines.update(pipelineId, remotePipeline))
  }

  // Docs are entity fields, written whether or not the settings block was taken.
  // Only what the remote actually carries is written: a repo with a README but no
  // LICENSE must not blank out a local license.
  // Docs: the user picked FILES, so only the picked pieces are written — taking
  // README.fr.md must not also overwrite the English one.
  const docPaths = [...selection.paths].filter((p) => etlDocTarget(p) !== null)
  if (docPaths.length > 0) {
    const fresh = await storage.etlPipelines.getById(pipelineId)
    const changes: Partial<EtlPipeline> = {}
    const readme: LocalizedString = { ...(presentReadme(fresh?.readme) ?? {}) }
    let readmeTouched = false
    for (const path of docPaths) {
      const target = etlDocTarget(path)
      if (target === 'license') {
        if (remoteDocs.license) changes.license = remoteDocs.license
      } else if (target) {
        const text = remoteDocs.readme?.[target.readmeLang]
        if (text != null) {
          readme[target.readmeLang] = text
          readmeTouched = true
        }
      }
    }
    if (readmeTouched) changes.readme = readme
    if (Object.keys(changes).length > 0) {
      await track(storage.etlPipelines.update(pipelineId, changes))
    }
  }

  // A write failed: the local content is NOT what the commit says, so surface it
  // and leave the anchor alone. The caller shows the error and keeps the banner.
  if (failed) throw new Error('etl-pull: some changes could not be written')

  // Two cursors, two meanings. `syncedOid` asserts "we hold this commit's
  // content", so ONLY taking that content may advance it — moving it after a
  // partial pull (or a keep-mine, which takes nothing at all) would rebuild
  // every later plan against a base we do not have, and the files left untaken
  // would never be offered again. `reviewedOid` only asserts "we have decided
  // about this commit", which is what unblocks the push: a user who took some
  // files and knowingly refused the rest has resolved the divergence, and must
  // not stay stuck behind it. (Server mode only; front-only has no anchor.)
  if (clonedOid) {
    const holdsContent = isCompleteEtlPull(plan, selection)
    if (holdsContent || selection.keepLocal || selection.decided) {
      await gitSetSyncState('etl-pipelines', pipelineId, branch, clonedOid, !holdsContent)
    }
  }
}
