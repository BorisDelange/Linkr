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
import { ENTITY_MANIFEST } from '@linkr/format'
import {
  dropForeignAuthorId,
  parseImportZip,
  readImportedManifest,
  stripInstanceFields,
  SCHEMA_PRESET_DDL_FILE,
} from '@/lib/entity-io'
import {
  presentReadme,
  readEntityDocsFrom,
  type EntityDocs,
} from '@/lib/entity-docs-pull'
import type { LocalizedString } from '@/types'

/** The manifest carrying the preset's mapping config and its name/description. */
export const PRESET_MANIFEST_FILE = ENTITY_MANIFEST

/**
 * The two things a preset pull offers, by SUBJECT rather than by file.
 *
 * `schema` is the structure of the data: the DDL and the mapping config that
 * names the tables and columns it defines. Splitting those two would let a
 * config land that points at a column the local DDL does not have — they are
 * one decision.
 *
 * `docs` is everything descriptive: README, licence, and the preset's own name
 * and description. Independent of the structure, hence its own decision — a
 * corrected README is worth taking without also adopting a DDL mid-rework.
 *
 * They straddle preset.json: the mapping config and the name/description live in
 * the same file, so the apply writes disjoint field sets rather than whole files.
 */
export type SchemaPresetPullGroup = 'schema' | 'docs'
export const SCHEMA_PRESET_PULL_GROUPS: SchemaPresetPullGroup[] = ['schema', 'docs']

/** Mapping fields that are descriptive, and so travel with the docs group. */
const DESCRIPTIVE_MAPPING_FIELDS = ['presetLabel', 'description'] as const

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
  /** The structure changed: the DDL, the mapping config, or both. */
  schemaChanged: boolean
  /** The DDL specifically — only used to label the row. */
  ddlChanged: boolean
  /** The mapping config specifically — only used to label the row. */
  mappingChanged: boolean
  /** Docs that differ: README*.md / LICENSE.md, plus the name/description. */
  docs: SchemaPresetPullItem[]
  /** The preset's own name or description changed (part of the docs group). */
  infoChanged: boolean
}

export interface PreparedSchemaPresetPull {
  plan: SchemaPresetPullPlan
  /** Remote `schema.ddl`, or null when the repo carries none. */
  remoteDdl: string | null
  /** Remote mapping config, minus the DDL, the descriptive and instance-local fields. */
  remoteMapping: Partial<SchemaMapping> | null
  /** Remote name + description — the descriptive half, applied with the docs. */
  remoteInfo: Partial<SchemaMapping>
  /** Remote README / LICENSE, read from the files beside the manifest. */
  remoteDocs: EntityDocs
  /** The local preset row — the "mine" side of every diff. */
  localPreset: CustomSchemaPreset | undefined
  /** The commit the clone landed on — the sync anchor after a successful pull. */
  clonedOid: string | null
  branch: string
}

export interface SchemaPresetPullSelection {
  /** Chosen groups — 'schema' and/or 'docs'. */
  groups: Set<SchemaPresetPullGroup>
  /** Deliberate "keep mine": take nothing, but still anchor on the remote commit. */
  keepLocal?: boolean
  /** Every item on offer got an explicit verdict (taken or refused). */
  decided?: boolean
}

/**
 * Strip the fields that belong to this instance rather than to the repo, and the
 * DDL — which travels as its own file.
 *
 * The descriptive fields go too: they are decided with the docs, not with the
 * structure, so leaving them here would make a renamed preset light the schema
 * row.
 */
export function stripInstancePresetMapping(remote: SchemaMapping): Partial<SchemaMapping> {
  const copy = stripInstanceFields(dropForeignAuthorId(remote)) as Record<string, unknown>
  for (const field of EXTRA_INSTANCE_PRESET_FIELDS) delete copy[field]
  for (const field of DESCRIPTIVE_MAPPING_FIELDS) delete copy[field]
  delete copy.ddl
  return copy as Partial<SchemaMapping>
}

/**
 * Canonical rendering of a mapping subset, for comparison.
 *
 * Keys are sorted into one order rather than passed to JSON.stringify as a
 * replacer array: a replacer filters each object by ITS OWN keys, so a field
 * present on one side only would drop out of both renderings and compare equal.
 */
function normMapping(m: Partial<SchemaMapping> | undefined): string {
  if (!m) return 'null'
  const entries = Object.entries(m)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
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
  return normMapping(local ? stripInstancePresetMapping(local) : undefined) !== normMapping(remote)
}

/** The descriptive half of the mapping: the preset's name and description. */
export function presetInfoOf(m: Partial<SchemaMapping> | undefined): Partial<SchemaMapping> {
  const out: Record<string, unknown> = {}
  for (const field of DESCRIPTIVE_MAPPING_FIELDS) {
    const value = (m as Record<string, unknown> | undefined)?.[field]
    if (value !== undefined) out[field] = value
  }
  return out as Partial<SchemaMapping>
}

/** Does the remote name or description differ from the local one? */
export function presetInfoChanged(
  local: SchemaMapping | undefined,
  remote: Partial<SchemaMapping> | null,
): boolean {
  if (!remote) return false
  return normMapping(presetInfoOf(local)) !== normMapping(presetInfoOf(remote))
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

  const rawRemote = readImportedManifest<CustomSchemaPreset>(parsed, 'schema-preset')
  if (!rawRemote) throw new Error('Cloned repository is not a valid schema preset export')

  // parseImportZip decodes every entry as text and JSON-parses what it can; the
  // DDL is plain SQL, so it comes back as a string.
  const raw = parsed[SCHEMA_PRESET_DDL_FILE]
  const remoteDdl = typeof raw === 'string' && raw ? raw : null
  const remoteMapping = rawRemote.mapping
    ? stripInstancePresetMapping(rawRemote.mapping)
    : null
  // Read off the RAW remote, not the stripped one: stripping removes exactly
  // these fields, so the stripped copy would always report "no change".
  const remoteInfo = presetInfoOf(rawRemote.mapping)
  const remoteDocs = readEntityDocsFrom(parsed, rawRemote)

  const ddlChanged = remoteDdl != null && remoteDdl !== preset?.mapping?.ddl
  const mappingChanged = presetMappingChanged(preset?.mapping, remoteMapping)

  return {
    plan: {
      schemaChanged: ddlChanged || mappingChanged,
      ddlChanged,
      mappingChanged,
      docs: presetDocItems(remoteDocs, preset),
      infoChanged: presetInfoChanged(preset?.mapping, remoteInfo),
    },
    remoteDdl,
    remoteMapping,
    remoteInfo,
    remoteDocs,
    localPreset: preset,
    clonedOid: cloned.oid,
    branch,
  }
}

/** The groups the plan actually offers — what a COMPLETE pull would take. */
export function schemaPresetPullPlanGroups(
  plan: SchemaPresetPullPlan,
): Set<SchemaPresetPullGroup> {
  const out = new Set<SchemaPresetPullGroup>()
  if (plan.schemaChanged) out.add('schema')
  if (plan.docs.length > 0 || plan.infoChanged) out.add('docs')
  return out
}

/**
 * Did this selection take everything the plan offered?
 *
 * The content anchor may only advance for a COMPLETE pull: it means "the content
 * of this commit is what we hold". Taking the schema but refusing the docs and
 * then claiming the commit would hide the latter for good.
 */
export function isCompleteSchemaPresetPull(
  plan: SchemaPresetPullPlan,
  selection: SchemaPresetPullSelection,
): boolean {
  for (const group of schemaPresetPullPlanGroups(plan)) {
    if (!selection.groups.has(group)) return false
  }
  return true
}

/**
 * Apply the resolved pull: write the chosen groups, then advance the sync anchor
 * — but only when the pull was COMPLETE and every write succeeded.
 *
 * Everything lands in ONE save. Both groups write to the same row — the schema
 * group into `mapping`, the docs group into `readme`/`license` AND into the
 * descriptive half of that same `mapping` — so two sequential saves would make
 * the second overwrite the first with a stale read.
 *
 * Throws when the write failed, so a failed apply cannot read as a successful pull.
 */
export async function applySchemaPresetPull(
  presetId: string,
  prepared: PreparedSchemaPresetPull,
  selection: SchemaPresetPullSelection,
  storage: Storage = getStorage(),
): Promise<void> {
  const { remoteDdl, remoteMapping, remoteInfo, remoteDocs, branch, clonedOid, plan } = prepared

  const takeSchema = selection.groups.has('schema')
  const takeDocs = selection.groups.has('docs')

  // Read fresh rather than trusting `prepared.localPreset`: the panel keeps a
  // draft across tab switches, so the row may have moved since it was prepared.
  const fresh = await storage.schemaPresets.getById(presetId)
  if (!fresh) throw new Error('schema-preset-pull: preset no longer exists')

  if (takeSchema || takeDocs) {
    let mapping: SchemaMapping = fresh.mapping
    if (takeSchema) {
      // The DDL and the config move together — they are one subject. Each half
      // falls back to the local value when the remote carries none, so taking
      // the group never empties what the repo simply does not have.
      mapping = {
        ...mapping,
        ...(remoteMapping ?? {}),
        ddl: remoteDdl ?? mapping?.ddl,
      }
    }
    if (takeDocs) mapping = { ...mapping, ...remoteInfo }

    const changes: Partial<CustomSchemaPreset> = { mapping }
    if (takeDocs) {
      // Only what the remote actually carries: a repo with a README but no
      // LICENSE must not blank out a local licence.
      const readme: LocalizedString = { ...(presentReadme(fresh.readme) ?? {}) }
      let readmeTouched = false
      for (const [lang, text] of Object.entries(presentReadme(remoteDocs.readme) ?? {})) {
        if (text == null) continue
        readme[lang] = text
        readmeTouched = true
      }
      if (readmeTouched) changes.readme = readme
      if (remoteDocs.license) changes.license = remoteDocs.license
    }

    try {
      await storage.schemaPresets.save({ ...fresh, ...changes })
    } catch (e) {
      // The local content is NOT what the commit says, so surface it and leave
      // the anchor alone. The caller shows the error and keeps the banner.
      console.warn('[schema-preset-pull] write failed:', e)
      throw new Error('schema-preset-pull: changes could not be written')
    }
  }

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
