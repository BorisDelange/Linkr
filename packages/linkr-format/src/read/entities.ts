/**
 * Read a standalone entity tree back into the spec that would re-write it.
 *
 * The dashboard half of read-modify-write shipped first (`read/dashboard.ts`);
 * this is the same contract for the six kinds that live in their own repo — SQL
 * collection, ETL pipeline, DQ rule set, data catalog, mapping project, schema
 * preset. Without it the only way to change one is to re-emit the whole spec
 * through `write_entity`, which means reconstructing it from files the agent can
 * only read directly — and an agent reading the tree directly is a step from
 * editing a derived id by hand.
 *
 * **Lossless, like the dashboard reader.** Anything the spec does not model rides
 * in `extra` and comes back in its original position, so a tree the app exported
 * re-serializes byte for byte. A reader that dropped `organization` or a run
 * status would quietly delete provenance on every edit.
 */
import { CONTENT_FILE, ENTITY_MANIFEST, MANIFEST, SCRIPTS_DIR, SIDECAR, type LayoutKind } from '../layout.js'
import { KEY_ORDER, type LocalizedInput, type Passthrough } from '../serialize/project.js'
import type {
  ConceptMappingSpec, DataCatalogSpec, DqCheckSpec, DqRuleSetSpec, EtlPipelineSpec,
  EventTableSpec, MappingProjectSpec, SchemaPresetSpec, ScriptFileSpec, SqlCollectionSpec,
} from '../serialize/entities.js'
import type { EntityTree } from '../tree.js'

/** Manifest keys the serializers compute; everything else is carried opaquely. */
const MANIFEST_KEYS = [
  'entityId', 'type', 'name', 'description', 'badges',
  'lineageId', 'parentLineageId', 'createdAt', 'version',
  // Kind-specific fields the specs model; listing them here keeps them out of
  // `extra`, where they would be written twice.
  'status', 'sourceType', 'dimensions', 'categoryColumn', 'subcategoryColumn', 'checks',
]

/** Kinds this module can read back. */
export type ReadableEntityKind =
  | 'sql-collection' | 'etl-pipeline' | 'dq-rule-set' | 'data-catalog' | 'mapping-project'
  | 'schema-preset'

export interface ReadEntityResult {
  kind: ReadableEntityKind
  spec: SqlCollectionSpec | EtlPipelineSpec | DqRuleSetSpec | DataCatalogSpec | MappingProjectSpec
    | SchemaPresetSpec
}

/**
 * Manifest fields the spec does not model, in the record's original key order.
 *
 * Same mechanism as the dashboard reader: `extra` alone holds the leftovers and
 * has no memory of where they sat, so the full order is recorded under a symbol
 * that never serializes.
 */
function extraOf(record: Record<string, unknown>, known: string[]): Passthrough | undefined {
  const out: Passthrough = {}
  let any = false
  for (const [key, value] of Object.entries(record)) {
    if (known.includes(key)) continue
    out[key] = value
    any = true
  }
  if (any) out[KEY_ORDER] = Object.keys(record)
  return any ? out : undefined
}

function nameOf(value: unknown): LocalizedInput {
  if (typeof value === 'string') return { en: value }
  if (value && typeof value === 'object') return value as LocalizedInput
  return { en: '' }
}

/** Identity + provenance, exactly the fields `EntityIdentity` declares. */
function identityOf(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(meta.entityId ? { entityId: meta.entityId } : {}),
    ...(meta.lineageId ? { lineageId: meta.lineageId } : {}),
    // `null` is a real value here, not an absence: the app always writes this
    // key (PROVENANCE_ORDER), so a truthy test would drop it and the very first
    // sync after an edit would show a deletion nobody made.
    ...(meta.parentLineageId !== undefined ? { parentLineageId: meta.parentLineageId } : {}),
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(meta.version ? { version: meta.version } : {}),
    ...(meta.badges ? { badges: meta.badges } : {}),
  }
}

function readJson<T>(tree: EntityTree, path: string): T | null {
  const raw = tree.read(path)
  if (raw == null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`${path} is not valid JSON.`)
  }
}

/** The manifest, under the shared name or the kind's retired one. */
function readManifest(tree: EntityTree, kind: LayoutKind): Record<string, unknown> {
  const meta = readJson<Record<string, unknown>>(tree, ENTITY_MANIFEST)
    ?? readJson<Record<string, unknown>>(tree, MANIFEST[kind])
  if (!meta) throw new Error(`No ${ENTITY_MANIFEST} in this tree.`)
  return meta
}

interface TreeEntry {
  path: string
  type?: string
  order?: number
}

/**
 * The `scripts/` file tree, in its recorded order.
 *
 * Folders are dropped: the serializer derives them from the file paths, so
 * carrying them back would double them on re-write. Order is kept — it is what
 * an ETL pipeline runs by, and losing it reorders the pipeline silently.
 */
function readScriptFiles(tree: EntityTree): ScriptFileSpec[] {
  const sidecar = readJson<TreeEntry[]>(tree, `${SCRIPTS_DIR}/${SIDECAR.tree}`)
    // A tree written before scripts/ existed keeps its files at the root.
    ?? readJson<TreeEntry[]>(tree, SIDECAR.tree)
  const prefix = tree.read(`${SCRIPTS_DIR}/${SIDECAR.tree}`) != null ? `${SCRIPTS_DIR}/` : ''

  if (!sidecar) {
    // No sidecar: fall back to whatever files are there, so a hand-made tree
    // still reads rather than coming back empty.
    return tree.paths()
      .filter((p) => p.startsWith(prefix || SCRIPTS_DIR) && !p.endsWith(SIDECAR.tree))
      .map((p) => ({ path: p.replace(prefix, ''), content: tree.read(p) ?? '' }))
  }

  return sidecar
    .filter((e) => e.type !== 'folder')
    .map((entry) => ({
      path: entry.path,
      content: tree.read(`${prefix}${entry.path}`) ?? '',
      ...(entry.order != null ? { order: entry.order } : {}),
    }))
}

/**
 * One standalone entity tree → the spec that reproduces it.
 *
 * `kind` is the caller's (from `detectTreeKind`), so this does not re-detect.
 */
export function readEntity(tree: EntityTree, kind: ReadableEntityKind): ReadEntityResult {
  const meta = readManifest(tree, kind)
  const head = {
    ...identityOf(meta),
    name: nameOf(meta.name),
    ...(meta.description ? { description: nameOf(meta.description) } : {}),
  }
  const extra = extraOf(meta, MANIFEST_KEYS)
  const tail = extra ? { extra } : {}

  switch (kind) {
    case 'sql-collection':
      return { kind, spec: { ...head, ...tail, files: readScriptFiles(tree) } as SqlCollectionSpec }

    case 'etl-pipeline':
      return {
        kind,
        spec: {
          ...head,
          ...(meta.status ? { status: meta.status as EtlPipelineSpec['status'] } : {}),
          ...tail,
          files: readScriptFiles(tree),
        } as EtlPipelineSpec,
      }

    case 'dq-rule-set': {
      // Checks live beside the manifest; an older tree inlined them under
      // `ruleSet`/`checks` in one bundle, which the app still writes for an
      // unlinked rule set.
      const checks = readJson<DqCheckSpec[]>(tree, CONTENT_FILE.dqChecks)
        ?? (meta.checks as DqCheckSpec[] | undefined)
        ?? []
      return { kind, spec: { ...head, ...tail, checks } as DqRuleSetSpec }
    }

    case 'data-catalog':
      return {
        kind,
        spec: {
          ...head,
          ...tail,
          dimensions: (meta.dimensions as string[]) ?? [],
          ...(meta.categoryColumn ? { categoryColumn: meta.categoryColumn as string } : {}),
          ...(meta.subcategoryColumn ? { subcategoryColumn: meta.subcategoryColumn as string } : {}),
        } as DataCatalogSpec,
      }

    case 'schema-preset': {
      // Payload lives beside the manifest: `mapping.json` (the table/column map)
      // and `schema.ddl` (50 kB of CREATE TABLE on a real preset — which is why
      // an event-table edit gets its own tool rather than a whole-spec rewrite).
      const mapping = readJson<Record<string, unknown>>(tree, CONTENT_FILE.schemaMapping) ?? {}
      const { eventTables, ...payload } = mapping
      return {
        kind,
        spec: {
          ...identityOf(meta),
          // A preset's identity is `presetId` in the spec, `entityId` on disk.
          presetId: (meta.entityId ?? '') as string,
          presetLabel: nameOf(meta.name),
          ...(meta.description ? { description: nameOf(meta.description) } : {}),
          ...(eventTables ? { eventTables: eventTables as Record<string, EventTableSpec> } : {}),
          mapping: payload,
          ...(tree.read(CONTENT_FILE.schemaDdl) != null
            ? { ddl: tree.read(CONTENT_FILE.schemaDdl) as string }
            : {}),
          ...tail,
        } as SchemaPresetSpec,
      }
    }

    case 'mapping-project': {
      const mappings = readJson<ConceptMappingSpec[]>(tree, MANIFEST['mapping-project']) ?? []
      return {
        kind,
        spec: {
          ...head,
          ...(meta.status ? { status: meta.status as MappingProjectSpec['status'] } : {}),
          ...(meta.sourceType ? { sourceType: meta.sourceType as string } : {}),
          ...tail,
          mappings,
        } as MappingProjectSpec,
      }
    }
  }
}

/** Kinds `readEntity` handles, for a caller that must refuse the others. */
export const READABLE_KINDS: readonly ReadableEntityKind[] = [
  'sql-collection', 'etl-pipeline', 'dq-rule-set', 'data-catalog', 'mapping-project',
  'schema-preset',
]

export function isReadableKind(kind: string): kind is ReadableEntityKind {
  return (READABLE_KINDS as readonly string[]).includes(kind)
}

/**
 * A project's manifest as the spec fields that rewrite it.
 *
 * Only the manifest: a project's datasets, dashboards and scripts are read with
 * `describe_tree` and edited with their own tools, so pulling megabytes of CSV
 * into a spec to rename a project would be the wrong trade.
 *
 * Lossless on the manifest, like every other reader here — a project carries 17
 * fields and the spec models 8, so without `extra` an edit would drop the
 * organization, the badges and the provenance.
 */
export function readProjectManifest(tree: EntityTree): Record<string, unknown> {
  const meta = readJson<Record<string, unknown>>(tree, ENTITY_MANIFEST)
    ?? readJson<Record<string, unknown>>(tree, MANIFEST.project)
  if (!meta) throw new Error(`No ${ENTITY_MANIFEST} in this tree.`)

  const known = [
    'entityId', 'projectId', 'type', 'name', 'description', 'shortDescription',
    'config', 'status', 'createdBy', 'createdAt', 'license', 'appVersion',
  ]
  const extra = extraOf(meta, known)

  return {
    // Either spelling reads; `entityId` is what gets written back.
    projectId: (meta.entityId ?? meta.projectId ?? '') as string,
    name: nameOf(meta.name),
    ...(meta.description ? { description: nameOf(meta.description) } : {}),
    ...(meta.shortDescription ? { shortDescription: nameOf(meta.shortDescription) } : {}),
    ...(meta.config ? { config: meta.config as Record<string, unknown> } : {}),
    ...(meta.status ? { status: meta.status as string } : {}),
    ...(meta.createdBy ? { createdBy: meta.createdBy as string } : {}),
    ...(meta.createdAt ? { createdAt: meta.createdAt as string } : {}),
    ...(meta.license ? { license: meta.license } : {}),
    appVersion: (meta.appVersion ?? '') as string,
    ...(extra ? { extra } : {}),
  }
}
