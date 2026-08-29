import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useOrganizationStore } from '@/stores/organization-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useFileStore } from '@/stores/file-store'
import { useWikiStore } from '@/stores/wiki-store'
import { useSqlScriptsStore } from '@/stores/sql-scripts-store'
import { useEtlStore } from '@/stores/etl-store'
import { useDqStore } from '@/stores/dq-store'
import { useCatalogStore } from '@/stores/catalog-store'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { isServerMode } from '@/lib/api-client'
import {
  resolveByLineage as resolveByLineageRule,
  resolveChildId as resolveChildIdRule,
  entityKey,
  resolveSlugLanding,
  resolveWorkspaceId,
} from '@/lib/import-identity'
import { mintEntityId } from '@/components/ui/entity-id-field'
import { localized } from '@/lib/localized'
import { deleteProjectData, importProjectContent, createEntityAttachments, projectSlug, reassemblePresetMapping, DB_ERROR_NO_DATA_ON_IMPORT } from '@/lib/entity-io'
import type { ParsedWorkspaceZip } from '@/lib/entity-io'
import { rederiveTreeIds } from '@/lib/entity-tree'
import { seedBuiltinPluginsForWorkspace } from '@/lib/plugins/default-plugins'
import { getStorage } from '@/lib/storage'
import type { DataSource, Project, WikiAttachment, LocalizedString, Workspace } from '@/types'

/** Append " (copy)" to every language of a multilingual name when duplicating. */
function copyLocalizedName(name: LocalizedString): LocalizedString {
  return Object.fromEntries(Object.entries(name ?? {}).map(([k, v]) => [k, `${v} (copy)`]))
}

/**
 * A database whose data lives in files this import cannot carry (DuckDB/SQLite,
 * and every non-`database` source type). Same split as retestDataSource: an
 * external server has a connection to retest, a file source has data to restore.
 */
function isFileBackedDatabase(ds: Partial<DataSource>): boolean {
  if (ds.sourceType !== 'database') return true
  const engine = (ds.connectionConfig as { engine?: string } | undefined)?.engine
  return engine === 'duckdb' || engine === 'sqlite'
}

export interface WorkspaceImportOptions {
  duplicate: boolean
  /** Progress reporting; the page passes its setState, a headless caller a no-op. */
  onPhase?: (phaseKey: string, done?: number, total?: number) => void
  /** Language used to render the skipped-organization name. */
  language: string
}

export interface WorkspaceImportResult {
  targetWsId: string
  idMap: Map<string, string>
  skippedOrgName: string | null
}

export async function importWorkspaceTree(
  parsed: ParsedWorkspaceZip,
  options: WorkspaceImportOptions,
): Promise<WorkspaceImportResult> {
  const { duplicate, onPhase } = options
  const storage = getStorage()
  const now = new Date().toISOString()
  const { appVersion: _av, ...wsMeta } = parsed.workspace
  /** Set when the linked organization could not be created (see the org block below). */
  let skippedOrgName: string | null = null
  // `organizationId` is stripped as an instance field, so the manifest carries
  // the org only as an inline snapshot — whose `id` IS the cross-instance UUID
  // (an org's UUID is stable; it is what the catalog indexes). Without putting
  // it back the FK stayed null and an imported workspace read "no organization"
  // even when its org had just been imported from the same content repo.
  // The workspace's own inline snapshot first — organization.json is the same
  // record, but the inline one is what this workspace was exported pointing at.
  const orgIdFromSnapshot =
    wsMeta.organizationId
    ?? (wsMeta.organization as { id?: string } | null | undefined)?.id
    ?? parsed.organization?.id
  if (orgIdFromSnapshot) wsMeta.organizationId = orgIdFromSnapshot
  // The manifest no longer carries the writing instance's `id` (parseWorkspaceZip
  // mints one), so a re-import is recognised by `lineageId` — the cross-instance
  // identity. Matching on the minted id would never hit, turning every re-import
  // into a duplicate instead of an update.
  const targetWsId = resolveWorkspaceId(
    duplicate ? [] : await storage.workspaces.getAll().catch(() => []),
    wsMeta,
    duplicate,
  ).id
  // On a duplicate, every git-linked child is re-minted with a fresh uuid; the
  // post-import auto-clone must target those NEW ids, not the ZIP's original ones.
  // Keyed `${type}:${originalId}` → new id (see GitLinkedEntity.type vocabulary).
  const idMap = new Map<string, string>()

  // Resolve the id a workspace-level child (SQL collection, ETL pipeline, DQ
  // rule set, mapping project, catalog, …) should land under. A duplicate always
  // gets a fresh uuid. A plain import keeps the ZIP id (so a git round-trip
  // overwrites in place) — EXCEPT when that id already belongs to a child in
  // ANOTHER workspace: the delete-then-create below would then move that other
  // workspace's entity into this one (silent cross-workspace clobber), so mint a
  // fresh id instead. Mirrors the uid guard in ProjectsPage.doImport.
  const resolveChildId = async (
    getById: (id: string) => Promise<{ workspaceId?: string } | undefined>,
    originalId: string,
  ): Promise<string> =>
    resolveChildIdRule(
      duplicate ? undefined : await getById(originalId).catch(() => undefined),
      originalId,
      targetWsId,
      duplicate,
    )

  /**
   * Where a lineage-bearing child should land. The rule itself lives in
   * lib/import-identity.ts (and is tested there); this only feeds it the rows.
   */
  const resolveByLineage = async (
    list: () => Promise<{ id: string; lineageId?: string; workspaceId?: string }[]>,
    child: { id?: string; lineageId?: string },
  ): Promise<{ id: string; replaces: string | null }> =>
    resolveByLineageRule(
      duplicate || !child.lineageId ? [] : await list().catch(() => []),
      child,
      targetWsId,
      duplicate,
    )

  /** Report a phase to the progress modal. Called between blocks of work. */
  const reportPhase = (phaseKey: string, done?: number, total?: number) => {
    onPhase?.(phaseKey, done, total)
  }
  /** Yield to the browser so React paints the new progress before the next sync block. */
  const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  reportPhase('workspaces.import_phase_workspace')
  await yieldToBrowser()

  // Reconstitute the linked organization first so the workspace's
  // organizationId FK resolves. Upsert by UUID: an org already present on this
  // instance (or shared by a sibling workspace / a duplicate) is left as-is;
  // only a genuinely new org is created. Duplicating keeps the same org link.
  // organization.json normally carries it; a tree that only has the manifest's
  // inline snapshot still gets a row, so the FK set above never dangles.
  // Best-effort: `organizations:write` is a separate global permission from
  // `workspaces:write`, so a user allowed to import may still be refused the org
  // (403). The org is provenance metadata — losing it must not cost the user the
  // whole import — but a dangling FK would render as a phantom organization, so
  // drop the link too and report it rather than failing silently.
  const orgRecord = parsed.organization?.id
    ? parsed.organization
    : (wsMeta.organization as typeof parsed.organization | null | undefined)
  if (orgRecord?.id) {
    const existingOrg = await storage.organizations.getById(orgRecord.id).catch(() => undefined)
    // Export strips instance fields (createdAt/updatedAt); re-stamp on import so
    // consumers (and the server's NOT-NULL columns) get a valid record.
    if (!existingOrg) {
      try {
        await storage.organizations.create({
          ...orgRecord,
          createdAt: orgRecord.createdAt ?? now,
          updatedAt: now,
        })
      } catch {
        delete (wsMeta as Partial<Workspace>).organizationId
        skippedOrgName = localized(orgRecord.name, options.language) || orgRecord.id
      }
    }
  }

  // A duplicate is a fork: it must NOT inherit the source's git link, or a
  // later sync would push over the original repo. A plain import keeps the
  // link set from the import source (workspace.json never carries it — export
  // strips gitRemoteConfig — so it's only ever the clone's remote).
  if (duplicate) delete (wsMeta as Partial<Workspace>).gitRemoteConfig

  // Create workspace if it doesn't exist yet, or update if overwriting
  const existingWs = await storage.workspaces.getById(targetWsId)
  if (existingWs && !duplicate) {
    await storage.workspaces.update(targetWsId, { ...wsMeta, updatedAt: now })
  } else {
    await storage.workspaces.create({
      ...wsMeta,
      id: targetWsId,
      // Imported: keep the author snapshot, drop the foreign local id — the
      // backend re-resolves createdById by ORCID/email (see doImport in
      // ProjectsPage for the full rationale).
      createdById: undefined,
      name: duplicate
        ? (typeof wsMeta.name === 'string'
          ? `${wsMeta.name} (copy)` as unknown as typeof wsMeta.name
          : Object.fromEntries(Object.entries(wsMeta.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as typeof wsMeta.name)
        : wsMeta.name,
      updatedAt: now,
      // Export strips instance fields (createdAt/updatedAt); re-stamp on import
      // so consumers that split() createdAt don't crash. Duplicate = fresh date.
      createdAt: duplicate ? now : (wsMeta.createdAt ?? now),
      // Fork on duplicate (new lineage + parent), keep lineage on plain import.
      ...(duplicate
        ? { lineageId: crypto.randomUUID(), parentLineageId: wsMeta.lineageId }
        : { lineageId: wsMeta.lineageId ?? crypto.randomUUID() }),
    })
  }

  // --- Import projects ---
  if (parsed.projects.size > 0) {
    reportPhase('workspaces.import_phase_projects', 0, parsed.projects.size)
    await yieldToBrowser()
  }
  let projectIdx = 0
  for (const [folder, parsedProject] of parsed.projects) {
    const { project } = parsedProject
    if (!project) continue
    // An export carries no `uid` (it is the writing instance's key, stripped on
    // purpose), so requiring one skipped every project of a git-published
    // workspace in silence. entityKey falls back to the slug, then the folder.
    project.uid = entityKey(project, folder)

    const uid = duplicate ? crypto.randomUUID() : project.uid
    const entity: Project = {
      ...project,
      // The pointer's git config is narrowed to url+branch: a tree written before
      // gitPointerManifest stopped spreading the whole config still carries the
      // transient syncedOid — and, from a client-only export, an authToken. Storing
      // either would put it back into the next export.
      ...(project.gitRemoteConfig
        ? { gitRemoteConfig: { url: project.gitRemoteConfig.url, branch: project.gitRemoteConfig.branch } }
        : {}),
      uid,
      // A git-linked pointer project.json carries no description.
      description: project.description ?? {},
      createdById: undefined,
      ...(() => {
        const slug = projectSlug(project)
        const next = duplicate ? (slug ? `${slug}-copy` : undefined) : slug
        return { entityId: next, projectId: next }
      })(),
      workspaceId: targetWsId,
      name: duplicate
        ? (typeof project.name === 'string'
          ? `${project.name} (copy)` as unknown as Project['name']
          : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
        : project.name,
      updatedAt: now,
      // Export strips instance fields (createdAt/updatedAt); re-stamp on import
      // so consumers that split() createdAt don't crash. Duplicate = fresh date.
      createdAt: duplicate ? now : (project.createdAt ?? now),
      // Fork on duplicate (new lineage + parent), keep lineage on plain import.
      ...(duplicate
        ? { lineageId: crypto.randomUUID(), parentLineageId: project.lineageId }
        : { lineageId: project.lineageId ?? crypto.randomUUID() }),
    }

    // Clean up existing data
    await deleteProjectData(storage, uid)
    await storage.projects.delete(uid).catch(() => {})

    await storage.projects.create(entity)

    // Write all sub-entities (child ids remapped to fresh UUIDs to avoid collisions).
    await importProjectContent(parsedProject, uid, storage)
    projectIdx++
    reportPhase('workspaces.import_phase_projects', projectIdx, parsed.projects.size)
    await yieldToBrowser()
  }

  // --- Import lightweight project entries (catalog-only) ---
  if (parsed.projectEntries.length > 0) {
    reportPhase('workspaces.import_phase_project_entries', 0, parsed.projectEntries.length)
    await yieldToBrowser()
  }
  for (const entry of parsed.projectEntries) {
    const { project } = entry
    if (!project) continue
    // Same as the full-content loop above: no `uid` in an export.
    project.uid = entityKey(project, entry.folder)
    const uid = duplicate ? crypto.randomUUID() : project.uid
    idMap.set(`project:${project.uid}`, uid)
    const existing = await storage.projects.getById(uid)
    if (existing && !duplicate) {
      // Update metadata + readme only
      await storage.projects.update(uid, {
        ...project, uid, workspaceId: targetWsId, readme: entry.readme ?? existing.readme, updatedAt: now,
      })
    } else {
      await storage.projects.create({
        ...project, uid, workspaceId: targetWsId,
        description: project.description ?? {},
        name: duplicate
          ? (typeof project.name === 'string'
            ? `${project.name} (copy)` as unknown as Project['name']
            : Object.fromEntries(Object.entries(project.name ?? {}).map(([k, v]) => [k, `${v} (copy)`])) as Project['name'])
          : project.name,
        readme: entry.readme ?? {},
        updatedAt: now,
        ...(duplicate ? { createdAt: now } : {}),
      })
    }
  }

  // --- Import schema presets ---
  if (parsed.schemas.length > 0) {
    reportPhase('workspaces.import_phase_schemas', 0, parsed.schemas.length)
    await yieldToBrowser()
  }
  for (const sp of parsed.schemas) {
    // mintEntityId, not randomUUID: a preset's id IS its user-facing
    // Identifier — it fills that field and the URL carries it — so a raw uuid
    // put a 36-character string in front of the user (same reason the catalog
    // install mints one, see freshId in lib/catalog/install.ts).
    // `entityId` is the slug a preset is addressed by; `presetId` is the retired
    // name for it and is optional, so it cannot stand alone here.
    const sourceSlug = sp.entityId ?? sp.presetId ?? sp.id
    const presetId = duplicate ? mintEntityId() : sourceSlug
    // The row's PK is `id` (minted below), not the slug — and that is what a
    // later clone must address, since save() puts to /schema-presets/{id}.
    const localId = duplicate ? crypto.randomUUID() : (sp.id ?? crypto.randomUUID())
    idMap.set(`schema-preset:${sourceSlug}`, localId)
    if (!duplicate) await storage.schemaPresets.delete(sourceSlug).catch(() => {})
    // `mapping.presetId` follows the entity id: a ZIP import reads it back as
    // the entity id and deletes whatever holds it, so letting the two drift
    // meant a later import deleted a different preset.
    await storage.schemaPresets.save({
      ...sp,
      presetId,
      // A duplicate is a new row, so it takes a new local key; a move keeps
      // the one it had. `entityId` follows the readable id either way.
      id: localId,
      entityId: duplicate ? presetId : (sp.entityId ?? presetId),
      // A git-linked preset exports as a POINTER, which carries its name at the
      // root and has no `mapping` at all — so spreading `sp.mapping` left the row
      // with no presetLabel, i.e. no name, until the repo was pulled. The clone
      // path already bridges the two; reuse it rather than re-deriving here.
      mapping: { ...reassemblePresetMapping(sp, sp.mapping), presetId },
      workspaceId: targetWsId,
    })
  }

  // --- Import databases (metadata only, no credentials/files) ---
  if (parsed.databases.length > 0) {
    reportPhase('workspaces.import_phase_databases', 0, parsed.databases.length)
    await yieldToBrowser()
  }
  for (const ds of parsed.databases) {
    if (!ds.id) continue
    // Lineage first — the manifest carries no local key, so that is what
    // recognises a re-import. A database written before databases had a lineage
    // (or by an older export) falls back to its id, which the flat form carried.
    const { id: byLineage } = await resolveByLineage(() => storage.dataSources.getAll(), ds)
    // `entityId` before `id`, matching collectGitLinkedEntities — the clone that
    // follows writes to THAT key. A git-linked database exports as a pointer
    // carrying `entityId` and no `id` at all, so the parser mints a UUID for it;
    // landing on that UUID left the clone unable to find this row, and it created
    // a second one under the slug. Two databases, same name, one of them empty.
    // Without a lineage a database cannot simply mint like the other types: the
    // clone that follows writes to the pointer's `entityId`, so landing anywhere
    // else orphans this row. The rule (and why it is still workspace-scoped)
    // lives in resolveSlugLanding.
    let landing: string
    if (ds.lineageId) {
      landing = byLineage
    } else {
      const key = ds.entityId ?? ds.id
      landing = resolveSlugLanding(
        key,
        await storage.dataSources.getById(key).catch(() => null),
        targetWsId,
      )
    }
    const id = duplicate ? crypto.randomUUID() : landing
    // Registered like every other git-linkable type, and BEFORE the early
    // `continue` below, so the clone can find this row whichever branch created
    // it — including when the key was taken and this import landed elsewhere.
    // Databases were the one kind missing from the map, which left the clone
    // falling back to the manifest's own key.
    idMap.set(`database:${ds.entityId ?? ds.id}`, id)
    if (!duplicate) {
      const existing = await storage.dataSources.getById(landing)
      if (existing) {
        // Update metadata only, keep existing credentials and file refs
        await storage.dataSources.update(landing, {
          name: ds.name, description: ds.description, alias: ds.alias,
          schemaMapping: ds.schemaMapping, updatedAt: now,
        })
        continue
      }
    }
    await storage.dataSources.create({
      // A git-linked database is a POINTER: its manifest carries identity and the
      // remote, and nothing else — the payload lives in the repo and arrives with
      // the clone a moment later. `alias` is the one field the server requires
      // with no default, so without this a workspace holding a linked database
      // fails its whole install on a 422 before any clone runs.
      //
      // It names the DuckDB schema (`ds_<alias>`); the entity id (else the row id)
      // is a unique stand-in until the clone writes the repo's own — the same
      // fallback applyClonedDatabase uses, so the two paths agree.
      alias: ds.alias ?? ds.entityId ?? id,
      // Same reasoning for the connection: an export writes none (a database's
      // rows never leave), yet every reader of a data source dereferences
      // `connectionConfig.engine` — so a pointer landed a row that threw on the
      // Databases page instead of reading as "no data yet". An empty file source
      // is what it truthfully is until the clone mounts its Parquet.
      connectionConfig: { engine: 'duckdb', fileIds: [], fileNames: [] },
      ...ds,
      id,
      workspaceId: targetWsId,
      status: 'disconnected',
      // Say WHY it is disconnected, as the standalone import does: a workspace
      // export is deliberately data-free, so a file-backed database lands empty.
      // Left silent, the row read "Disconnected" with nothing to act on — and the
      // one action that fixes it (rebuild from the DDL) hangs off this reason.
      // Only for file-backed engines: an external server is disconnected because
      // nobody has retested it, which is a different state with a different fix.
      ...(isFileBackedDatabase(ds) ? { errorMessage: DB_ERROR_NO_DATA_ON_IMPORT } : {}),
      // The file carries the date the database was created; re-stamping it here
      // made every reimport read as brand new. Matches applyClonedDatabase.
      createdAt: ds.createdAt ?? now,
      updatedAt: now,
    } as DataSource)
  }

  // --- Import the workspace README's images ---
  await createEntityAttachments(storage, parsed.workspaceAttachments, 'workspace', targetWsId, targetWsId)

  // --- Import wiki pages ---
  if (parsed.wikiPages.length > 0) {
    reportPhase('workspaces.import_phase_wiki', 0, parsed.wikiPages.length)
    await yieldToBrowser()
    if (!duplicate) {
      await storage.wikiAttachments.deleteByWorkspace(targetWsId).catch(() => {})
      await storage.wikiPages.deleteByWorkspace(targetWsId).catch(() => {})
    }
    const wikiIdMap = new Map<string, string>()
    const mapWikiId = (oldId: string): string => {
      if (!duplicate) return oldId
      if (!wikiIdMap.has(oldId)) wikiIdMap.set(oldId, crypto.randomUUID())
      return wikiIdMap.get(oldId)!
    }
    for (const page of parsed.wikiPages) {
      await storage.wikiPages.create({
        ...page,
        id: mapWikiId(page.id),
        workspaceId: targetWsId,
        parentId: page.parentId ? mapWikiId(page.parentId) : null,
        updatedAt: now,
      })
    }
    for (const meta of parsed.wikiAttachmentsMeta) {
      const blobData = parsed.wikiAttachmentBlobs.get(meta.id)
      if (blobData) {
        await storage.wikiAttachments.create({
          ...meta,
          id: duplicate ? crypto.randomUUID() : meta.id,
          pageId: mapWikiId(meta.pageId),
          workspaceId: targetWsId,
          data: blobData,
        } as WikiAttachment)
      }
    }
  }

  // --- Import SQL script collections ---
  if (parsed.sqlCollections.length > 0) {
    reportPhase('workspaces.import_phase_sql', 0, parsed.sqlCollections.length)
    await yieldToBrowser()
  }
  for (const { collection, files } of parsed.sqlCollections) {
    const { id, replaces } = await resolveByLineage(() => storage.sqlScriptCollections.getAll(), collection)
    idMap.set(`sql-collection:${collection.entityId ?? collection.id}`, id)
    if (replaces) {
      await storage.sqlScriptFiles.deleteByCollection(replaces).catch(() => {})
      await storage.sqlScriptCollections.delete(replaces).catch(() => {})
    }
    await storage.sqlScriptCollections.create({
      ...collection, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate
        ? { name: copyLocalizedName(collection.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: collection.lineageId }
        : { lineageId: collection.lineageId ?? crypto.randomUUID() }),
    })
    // parseWorkspaceZip derived the ids from the ZIP's own collection id; when
    // the target id differs (a duplicate, or a plain import that dodged a
    // cross-workspace collision) re-derive them from the target so they can't
    // collide with the other workspace's files.
    const targetFiles = id === collection.id
      ? files
      : rederiveTreeIds(files, collection.id, id, 'collectionId')
    for (const f of targetFiles) {
      await storage.sqlScriptFiles.create({ ...f, collectionId: id })
    }
  }

  // --- Import ETL pipelines ---
  if (parsed.etlPipelines.length > 0) {
    reportPhase('workspaces.import_phase_etl', 0, parsed.etlPipelines.length)
    await yieldToBrowser()
  }
  for (const { pipeline, files, attachments } of parsed.etlPipelines) {
    const { id, replaces } = await resolveByLineage(() => storage.etlPipelines.getAll(), pipeline)
    idMap.set(`etl-pipeline:${pipeline.entityId ?? pipeline.id}`, id)
    if (replaces) {
      await storage.etlFiles.deleteByPipeline(replaces).catch(() => {})
      await storage.etlPipelines.delete(replaces).catch(() => {})
    }
    await storage.etlPipelines.create({
      ...pipeline, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate
        ? { name: copyLocalizedName(pipeline.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: pipeline.lineageId }
        : { lineageId: pipeline.lineageId ?? crypto.randomUUID() }),
    })
    const targetFiles = id === pipeline.id
      ? files
      : rederiveTreeIds(files, pipeline.id, id, 'pipelineId')
    for (const f of targetFiles) {
      await storage.etlFiles.create({ ...f, pipelineId: id })
    }
    await createEntityAttachments(storage, attachments, 'etl-pipeline', id, targetWsId)
  }

  // --- Import DQ rule sets ---
  if (parsed.dqRuleSets.length > 0) {
    reportPhase('workspaces.import_phase_dq', 0, parsed.dqRuleSets.length)
    await yieldToBrowser()
  }
  for (const { ruleSet, checks } of parsed.dqRuleSets) {
    const { id, replaces } = await resolveByLineage(() => storage.dqRuleSets.getAll(), ruleSet)
    idMap.set(`dq-rule-set:${ruleSet.entityId ?? ruleSet.id}`, id)
    if (replaces) {
      await storage.dqCustomChecks.deleteByRuleSet(replaces).catch(() => {})
      await storage.dqRuleSets.delete(replaces).catch(() => {})
    }
    await storage.dqRuleSets.create({
      ...ruleSet, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate
        ? { name: copyLocalizedName(ruleSet.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: ruleSet.lineageId }
        : { lineageId: ruleSet.lineageId ?? crypto.randomUUID() }),
    })
    const remintChecks = id !== ruleSet.id
    for (const check of checks) {
      await storage.dqCustomChecks.create({
        ...check, id: remintChecks ? crypto.randomUUID() : check.id, ruleSetId: id,
      })
    }
  }

  // --- Import concept sets ---
  if (parsed.conceptSets.length > 0) {
    reportPhase('workspaces.import_phase_concept_sets', 0, parsed.conceptSets.length)
    await yieldToBrowser()
  }
  for (const cs of parsed.conceptSets) {
    const id = await resolveChildId((i) => storage.conceptSets.getById(i), cs.id)
    if (id === cs.id) await storage.conceptSets.delete(cs.id).catch(() => {})
    await storage.conceptSets.create({
      ...cs, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate ? { name: `${cs.name} (copy)`, createdAt: now } : {}),
    })
  }

  // --- Import mapping projects ---
  if (parsed.mappingProjects.length > 0) {
    const totalMappings = parsed.mappingProjects.reduce((s, mp) => s + mp.mappings.length, 0)
    reportPhase('workspaces.import_phase_mappings', 0, totalMappings)
    await yieldToBrowser()
    let mappingIdx = 0
    const reportEvery = Math.max(1, Math.floor(totalMappings / 100)) // ~100 UI updates max
    for (const { project: mp, mappings, scoresFile } of parsed.mappingProjects) {
      const { id, replaces } = await resolveByLineage(() => storage.mappingProjects.getAll(), mp)
      // Keyed on the identity the manifest actually carries. A git-linked
      // project exports as a pointer with no `id`, so every one of them keyed
      // this map at "mapping-project:undefined": each overwrote the last, and
      // all their clones then retargeted onto the single surviving id — six
      // projects imported empty while one received everyone's content.
      idMap.set(`mapping-project:${mp.entityId ?? mp.id}`, id)
      // The mappings' own ids are namespaced by the project id, so they must be
      // re-minted whenever this import did not land on the row it replaces.
      const remintMappings = !replaces
      if (replaces) {
        await storage.conceptMappings.deleteByProject(replaces).catch(() => {})
        await storage.mappingProjects.delete(replaces).catch(() => {})
      }
      await storage.mappingProjects.create({
        ...mp, id, workspaceId: targetWsId, updatedAt: now,
        ...(duplicate
          ? { name: copyLocalizedName(mp.name), createdAt: now, lineageId: crypto.randomUUID(), parentLineageId: mp.lineageId }
          : { lineageId: mp.lineageId ?? crypto.randomUUID() }),
      })
      if (scoresFile) {
        // Untrusted ZIP input — validate columns before persisting, same as the interactive load flow.
        if (isServerMode()) {
          // The server attach endpoint validates the parquet before storing it.
          const { persistScoresFileOnServer } = await import('@/lib/api/scores')
          await persistScoresFileOnServer(id, scoresFile).catch(() => {})
        } else {
          const [{ persistScoresFile }, { validateScoresFile }] = await Promise.all([
            import('@/lib/concept-mapping/scores-engine'),
            import('@/lib/concept-mapping/scores-parser'),
          ])
          const validation = await validateScoresFile(scoresFile)
          if (validation.ok) await persistScoresFile(id, scoresFile).catch(() => {})
        }
      }
      for (const m of mappings) {
        await storage.conceptMappings.create({
          ...m, id: remintMappings ? crypto.randomUUID() : m.id, projectId: id,
        })
        mappingIdx++
        if (mappingIdx % reportEvery === 0) {
          reportPhase('workspaces.import_phase_mappings', mappingIdx, totalMappings)
          await yieldToBrowser()
        }
      }
      // `stats` came in on the project.json we just wrote, but it is DERIVED
      // from these mappings — an export with stale counters would otherwise
      // keep displaying the wrong number here for good.
      const { recomputeImportedStats } = await import('@/lib/concept-mapping/import')
      await recomputeImportedStats(id, mp, storage)
    }
    reportPhase('workspaces.import_phase_mappings', totalMappings, totalMappings)
    await yieldToBrowser()
  }

  // --- Import source concept ID registry (ranges + entries) ---
  // Fire when EITHER is present: entries now come from per-project subfolders,
  // so a workspace can carry entries even if the root ranges.json is absent.
  if (parsed.sourceConceptIdRanges.length > 0 || parsed.sourceConceptIdEntries.length > 0) {
    reportPhase('workspaces.import_phase_source_id_registry', 0, parsed.sourceConceptIdEntries.length)
    await yieldToBrowser()
    if (!duplicate) {
      await storage.sourceConceptIdRanges.deleteByWorkspace(targetWsId).catch(() => {})
      await storage.sourceConceptIdEntries.deleteByWorkspace(targetWsId).catch(() => {})
    }
    for (const range of parsed.sourceConceptIdRanges) {
      const badgeLabel = duplicate ? `${range.badgeLabel} (copy)` : range.badgeLabel
      await storage.sourceConceptIdRanges.save({
        ...range, workspaceId: targetWsId, badgeLabel, createdAt: range.createdAt ?? now, updatedAt: now,
      })
    }
    if (parsed.sourceConceptIdEntries.length > 0) {
      await storage.sourceConceptIdEntries.saveBatch(
        parsed.sourceConceptIdEntries.map(entry => {
          const badgeLabel = duplicate ? `${entry.badgeLabel} (copy)` : entry.badgeLabel
          const newId = duplicate
            ? `${targetWsId}__${badgeLabel}__${entry.vocabularyId}__${entry.conceptCode}`
            : entry.id
          return { ...entry, id: newId, workspaceId: targetWsId, badgeLabel }
        })
      )
    }
  }

  // --- Import catalogs ---
  if (parsed.catalogs.length > 0) {
    reportPhase('workspaces.import_phase_catalogs', 0, parsed.catalogs.length)
    await yieldToBrowser()
  }
  for (const cat of parsed.catalogs) {
    const { id, replaces } = await resolveByLineage(() => storage.dataCatalogs.getAll(), cat)
    idMap.set(`data-catalog:${cat.entityId ?? cat.id}`, id)
    if (replaces) await storage.dataCatalogs.delete(replaces).catch(() => {})
    await storage.dataCatalogs.create({
      ...cat, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate ? { name: copyLocalizedName(cat.name), createdAt: now } : {}),
    })
  }

  // --- Import service mappings ---
  if (parsed.serviceMappings.length > 0) {
    reportPhase('workspaces.import_phase_service_mappings', 0, parsed.serviceMappings.length)
    await yieldToBrowser()
  }
  for (const sm of parsed.serviceMappings) {
    const id = await resolveChildId((i) => storage.serviceMappings.getById(i), sm.id)
    if (id === sm.id) await storage.serviceMappings.delete(sm.id).catch(() => {})
    await storage.serviceMappings.create({
      ...sm, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate ? { name: `${sm.name} (copy)`, createdAt: now } : {}),
    })
  }

  // --- Import plugins ---
  if (parsed.plugins.length > 0) {
    reportPhase('workspaces.import_phase_plugins', 0, parsed.plugins.length)
    await yieldToBrowser()
  }
  for (const plugin of parsed.plugins) {
    // The manifest carries no local key, so `plugin.id` was undefined here: the
    // delete below was a no-op and every re-import piled up another copy.
    // Lineage is what recognises the row, as for every other workspace child.
    const byLineage = await resolveByLineage(() => storage.userPlugins.getAll(), plugin)
    // A plugin created before lineage was stamped (or imported from a bare ZIP)
    // has none, so the rule above cannot recognise it and would mint yet another
    // copy on every re-import. Fall back to its slug within THIS workspace — the
    // same landing rule databases use, and the same workspace boundary, so a
    // sibling workspace's plugin of the same name is never touched.
    const bySlug = byLineage.replaces || duplicate || !plugin.entityId
      ? null
      : (await storage.userPlugins.getAll().catch(() => []))
        .find((p) => p.entityId === plugin.entityId && p.workspaceId === targetWsId) ?? null
    const id = bySlug?.id ?? byLineage.id
    const replaces = bySlug?.id ?? byLineage.replaces
    if (replaces) await storage.userPlugins.delete(replaces).catch(() => {})
    await storage.userPlugins.create({
      ...plugin, id, workspaceId: targetWsId, updatedAt: now,
      ...(duplicate ? { createdAt: now } : {}),
    })
  }
  // Built-in plugins are stripped from the export (reconstitutable from the app
  // registry), so re-seed them here — idempotent per workspace, unique row ids.
  await seedBuiltinPluginsForWorkspace(targetWsId)

  reportPhase('workspaces.import_phase_finalizing')
  await yieldToBrowser()

  // Invalidate in-memory caches so stores reload from IDB on next open
  useDashboardStore.setState({ activeProjectUid: null, loaded: false })
  useDatasetStore.setState({ activeProjectUid: null })
  useFileStore.setState({ activeProjectUid: null })
  useWikiStore.setState({ pagesLoaded: false, currentWorkspaceId: null })
  useSqlScriptsStore.setState({ collectionsLoaded: false })
  useEtlStore.setState({ etlPipelinesLoaded: false })
  useDqStore.setState({ dqRuleSetsLoaded: false })
  // NB: never flip catalogsLoaded to false — it feeds App.tsx's full-screen gate,
  // which would unmount this page (and kill the import-progress modal). Reload the
  // catalog store below instead (loadCatalogs sets the flag straight back to true).
  // Concept mapping: also clear the in-memory `mappings` array — leftover entries from a
  // previously-deleted workspace would otherwise pollute the new project view.
  {
    const cm = useConceptMappingStore.getState()
    useConceptMappingStore.setState({
      mappingProjectsLoaded: false,
      conceptSetsLoaded: false,
      mappings: [],
      mappingsById: new Map(),
      mappingsVersion: cm.mappingsVersion + 1,
      mappingsStructureVersion: cm.mappingsStructureVersion + 1,
      mappingsLoaded: false,
      activeProjectId: null,
      otherProjectsMappedKeys: new Set(),
      otherProjectsMappings: new Map(),
      _otherKeysLoadedFor: null,
      _otherDetailsLoadedFor: null,
    })
  }
  await useWorkspaceStore.getState().loadWorkspaces()
  // Import creates the linked organization straight through storage (bypassing
  // the org store), so reload it — else Settings > Organizations and the
  // workspace's org field stay empty until a full app reload.
  await useOrganizationStore.getState().loadOrganizations()
  await useAppStore.getState().loadProjects()
  // catalogsLoaded feeds the global App-shell gate: leaving it false replaces the
  // whole app with a full-screen loader. Reload it now (flips the flag back to true)
  // instead of waiting for some later loadCatalogs() to un-block the shell.
  await useCatalogStore.getState().loadCatalogs()
  return { targetWsId, idMap, skippedOrgName }
}
