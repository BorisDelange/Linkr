/**
 * Pull orchestration for a schema preset — the additive-overlay model, as for
 * ETL pipelines (`etl-pull.ts`), not the mapping-project 3-way merge.
 *
 * A preset repo is the simplest of all: three units, each all-or-nothing.
 *   - `schema.ddl`     the SQL that creates the tables
 *   - `preset.json`    the mapping config (which table/column plays which role)
 *   - README / LICENSE the entity's docs, as everywhere else
 *
 * There is no file tree and no per-item merge: a DDL is only meaningful whole
 * (half a CREATE TABLE is not a schema), and the mapping config is arbitrated
 * against a DDL it must stay consistent with. So each is one row the user takes
 * or leaves, exactly like the ETL settings block.
 */
import type { CustomSchemaPreset, SchemaMapping } from '@/types'
import type { Storage } from '@/lib/storage'
import { getStorage } from '@/lib/storage'
import { gitCloneToZip, gitSetSyncState } from '@/lib/api/git'
import { cleanGitUrl } from '@/lib/git-clone'
import { README_FILE_RE } from '@/lib/entity-tree'
import {
  dropForeignAuthorId,
  parseImportZip,
  stripInstanceFields,
  SCHEMA_PRESET_DDL_FILE,
} from '@/lib/entity-io'
import {
  presentReadme,
  readEntityDocsFrom,
  type EntityDocs,
} from '@/lib/entity-docs-pull'
import type { LocalizedString } from '@/types'

/** The manifest carrying the preset's mapping config. */
export const PRESET_MANIFEST_FILE = 'preset.json'
/** Item key for the mapping-config block (the manifest's only unit). */
export const PRESET_MAPPING_KEY = 'mapping'
/** Item key for the DDL block (schema.ddl's only unit). */
export const PRESET_DDL_KEY = 'ddl'

/**
 * Preset fields a pull must NOT take, on top of the shared export list
 * (`stripInstanceFields`, which already drops workspaceId, gitRemoteConfig,
 * organization, updatedAt, createdById…).
 *
 *   - presetId is identity, resolved locally: taking the repo's would rename the
 *     preset out from under every database pointing at it by id
 *   - createdAt belongs to the local row's history
 *   - readme / license are DOCS, not config: preset.json carries only the
 *     licence's id and name, its text living in LICENSE.md beside it. Writing the
 *     manifest's copy would replace a complete local licence with a text-less
 *     stub — the export then omits LICENSE.md (it reads as "deleted" on the next
 *     push) and the licence editor breaks on the missing text.
 */
const EXTRA_INSTANCE_PRESET_FIELDS = ['presetId', 'createdAt', 'readme', 'license'] as const

/** One remote block the user can choose to pull. */
export interface SchemaPresetPullItem {
  /** The repo path — the natural key, and the selection id. */
  key: string
  /** True when the block already exists locally → pulling OVERWRITES it. */
  exists: boolean
}

export interface SchemaPresetPullPlan {
  /** The remote DDL differs from the local one. */
  ddlChanged: boolean
  /** The remote mapping config differs from the local one. */
  mappingChanged: boolean
  /** Docs files that differ (README*.md / LICENSE.md). */
  docs: SchemaPresetPullItem[]
}

export interface PreparedSchemaPresetPull {
  plan: SchemaPresetPullPlan
  /** Remote `schema.ddl`, or null when the repo carries none. */
  remoteDdl: string | null
  /** Remote mapping config, minus the DDL and instance-local fields. */
  remoteMapping: Partial<SchemaMapping> | null
  /** Remote README / LICENSE, read from the files beside the manifest. */
  remoteDocs: EntityDocs
  /** The local preset row — the "mine" side of every diff. */
  localPreset: CustomSchemaPreset | undefined
  /** The commit the clone landed on — the sync anchor after a successful pull. */
  clonedOid: string | null
  branch: string
}

export interface SchemaPresetPullSelection {
  /** Chosen paths — schema.ddl, preset.json, and/or docs files. */
  paths: Set<string>
  /** Deliberate "keep mine": take nothing, but still anchor on the remote commit. */
  keepLocal?: boolean
  /** Every item on offer got an explicit verdict (taken or refused). */
  decided?: boolean
}

/** Map a chosen docs path back to what it writes: a readme language, or the licence. */
export function presetDocTarget(path: string): { readmeLang: string } | 'license' | null {
  if (/^LICENSE\.md$/i.test(path)) return 'license'
  const m = README_FILE_RE.exec(path)
  return m ? { readmeLang: (m[1] ?? 'en').toLowerCase() } : null
}

/**
 * Strip the fields that belong to this instance rather than to the repo, and the
 * DDL — which travels as its own file and is decided separately.
 */
export function stripInstancePresetMapping(remote: SchemaMapping): Partial<SchemaMapping> {
  const copy = stripInstanceFields(dropForeignAuthorId(remote)) as Record<string, unknown>
  for (const field of EXTRA_INSTANCE_PRESET_FIELDS) delete copy[field]
  delete copy.ddl
  return copy as Partial<SchemaMapping>
}

/** Does the remote mapping config differ from the local one? */
export function presetMappingChanged(
  local: SchemaMapping | undefined,
  remote: Partial<SchemaMapping> | null,
): boolean {
  if (!remote) return false
  // BOTH sides go through the same stripping, so the comparison sees the same
  // shape on each. Normalising only the remote (which is what arrives already
  // stripped) would compare it against a local copy that still carries presetId
  // and friends — every preset would then report a permanent difference.
  //
  // The DDL is dropped by that stripping too: it is its own row, and counting it
  // here would light both toggles for one change.
  //
  // Keys are sorted into one canonical order rather than passed to
  // JSON.stringify as a replacer array: a replacer filters each object by ITS
  // OWN keys, so a field present on one side only would drop out of both
  // renderings and compare equal.
  const norm = (m: Partial<SchemaMapping> | undefined) => {
    if (!m) return 'null'
    const entries = Object.entries(m)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify(entries)
  }
  return norm(local ? stripInstancePresetMapping(local) : undefined) !== norm(remote)
}

/** Docs blocks that differ between the remote and the local preset. */
export function presetDocItems(
  remote: EntityDocs,
  local: CustomSchemaPreset | undefined,
): SchemaPresetPullItem[] {
  const items: SchemaPresetPullItem[] = []
  const localReadme = presentReadme(local?.readme)
  for (const [lang, text] of Object.entries(presentReadme(remote.readme) ?? {})) {
    const mine = localReadme?.[lang]
    if (!text || text === mine) continue
    // The primary language is the suffix-free file, mirroring writeReadmeFiles.
    items.push({ key: lang === 'en' ? 'README.md' : `README.${lang}.md`, exists: mine != null })
  }
  if (remote.license?.text && remote.license.text !== local?.license?.text) {
    items.push({ key: 'LICENSE.md', exists: !!local?.license })
  }
  return items
}

/** Clone the preset's linked remote and diff it against the local row. */
export async function prepareSchemaPresetPull(
  presetId: string,
  branch: string,
): Promise<PreparedSchemaPresetPull> {
  const storage = getStorage()
  const preset = await storage.schemaPresets.getById(presetId)
  const url = preset?.gitRemoteConfig?.url
  if (!url) throw new Error('Schema preset is not linked to a git remote')

  const cloned = await gitCloneToZip(cleanGitUrl(url), branch)
  const parsed = await parseImportZip(new File([cloned.blob], 'pull.zip'))

  const rawRemote = parsed[PRESET_MANIFEST_FILE] as CustomSchemaPreset | undefined
  if (!rawRemote) throw new Error('Cloned repository is not a valid schema preset export')

  // parseImportZip decodes every entry as text and JSON-parses what it can; the
  // DDL is plain SQL, so it comes back as a string.
  const raw = parsed[SCHEMA_PRESET_DDL_FILE]
  const remoteDdl = typeof raw === 'string' && raw ? raw : null
  const remoteMapping = rawRemote.mapping
    ? stripInstancePresetMapping(rawRemote.mapping)
    : null
  const remoteDocs = readEntityDocsFrom(parsed, rawRemote)

  return {
    plan: {
      ddlChanged: remoteDdl != null && remoteDdl !== preset?.mapping?.ddl,
      mappingChanged: presetMappingChanged(preset?.mapping, remoteMapping),
      docs: presetDocItems(remoteDocs, preset),
    },
    remoteDdl,
    remoteMapping,
    remoteDocs,
    localPreset: preset,
    clonedOid: cloned.oid,
    branch,
  }
}

/** Every actionable path the plan offers — what a COMPLETE pull would take. */
export function schemaPresetPullPlanPaths(plan: SchemaPresetPullPlan): Set<string> {
  const out = new Set<string>()
  if (plan.ddlChanged) out.add(SCHEMA_PRESET_DDL_FILE)
  if (plan.mappingChanged) out.add(PRESET_MANIFEST_FILE)
  for (const item of plan.docs) out.add(item.key)
  return out
}

/**
 * Did this selection take everything the plan offered?
 *
 * The content anchor may only advance for a COMPLETE pull: it means "the content
 * of this commit is what we hold". Taking the DDL but refusing the mapping config
 * and then claiming the commit would hide the latter for good.
 */
export function isCompleteSchemaPresetPull(
  plan: SchemaPresetPullPlan,
  selection: SchemaPresetPullSelection,
): boolean {
  for (const path of schemaPresetPullPlanPaths(plan)) {
    if (!selection.paths.has(path)) return false
  }
  return true
}

/**
 * Apply the resolved pull: write the chosen blocks, then advance the sync anchor
 * — but only when the pull was COMPLETE and every write succeeded.
 *
 * The DDL and the mapping config are written in ONE update when both are taken:
 * they are two halves of the same `mapping` field, and two sequential updates
 * would make the second overwrite the first with a stale read.
 *
 * Throws when a write failed, so a partial apply cannot read as a successful pull.
 */
export async function applySchemaPresetPull(
  presetId: string,
  prepared: PreparedSchemaPresetPull,
  selection: SchemaPresetPullSelection,
  storage: Storage = getStorage(),
): Promise<void> {
  const { remoteDdl, remoteMapping, remoteDocs, branch, clonedOid, plan } = prepared
  let failed = false
  const track = async (op: Promise<unknown>): Promise<void> => {
    try {
      await op
    } catch (e) {
      failed = true
      console.warn('[schema-preset-pull] write failed:', e)
    }
  }

  const takeDdl = selection.paths.has(SCHEMA_PRESET_DDL_FILE) && remoteDdl != null
  const takeMapping = selection.paths.has(PRESET_MANIFEST_FILE) && remoteMapping != null

  // Read fresh rather than trusting `prepared.localPreset`: the panel keeps a
  // draft across tab switches, so the row may have moved since it was prepared.
  const fresh = await storage.schemaPresets.getById(presetId)
  if (!fresh) throw new Error('schema-preset-pull: preset no longer exists')

  if (takeDdl || takeMapping) {
    // One write, both halves. The local DDL is kept when only the config was
    // taken (and vice versa), so a partial pull never empties the other half.
    const mapping: SchemaMapping = {
      ...(takeMapping ? { ...fresh.mapping, ...remoteMapping } : fresh.mapping),
      ddl: takeDdl ? remoteDdl : fresh.mapping?.ddl,
    }
    await track(storage.schemaPresets.save({ ...fresh, mapping }))
  }

  // Docs: the user picked FILES, so only the picked pieces are written — taking
  // README.fr.md must not also overwrite the English one.
  const docPaths = [...selection.paths].filter((p) => presetDocTarget(p) !== null)
  if (docPaths.length > 0) {
    const current = await storage.schemaPresets.getById(presetId)
    if (current) {
      const changes: Partial<CustomSchemaPreset> = {}
      const readme: LocalizedString = { ...(presentReadme(current.readme) ?? {}) }
      let readmeTouched = false
      for (const path of docPaths) {
        const target = presetDocTarget(path)
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
        await track(storage.schemaPresets.save({ ...current, ...changes }))
      }
    }
  }

  // A write failed: the local content is NOT what the commit says, so surface it
  // and leave the anchor alone. The caller shows the error and keeps the banner.
  if (failed) throw new Error('schema-preset-pull: some changes could not be written')

  // Two cursors, two meanings — see the note in etl-pull.ts. `syncedOid` asserts
  // "we hold this commit's content" and may only advance on a complete pull;
  // `reviewedOid` asserts "we have decided about this commit", which is what
  // unblocks the push after a knowing partial pull. (Server mode only.)
  if (clonedOid) {
    const holdsContent = isCompleteSchemaPresetPull(plan, selection)
    if (holdsContent || selection.keepLocal || selection.decided) {
      await gitSetSyncState('schema-presets', presetId, branch, clonedOid, !holdsContent)
    }
  }
}
