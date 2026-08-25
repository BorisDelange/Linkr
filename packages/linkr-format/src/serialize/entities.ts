/**
 * Serialize the standalone entities: SQL collection, ETL pipeline, DQ rule set,
 * data catalog, mapping project, schema preset.
 *
 * Same contract as `serialize/project.ts` — a spec in, `{ path, content }` pairs
 * out, no I/O — so one caller can write any kind to disk, a ZIP, or anywhere
 * else. Each spec is a **simplified authoring view**: it carries what an author
 * supplies, not every field the app later attaches (run timestamps, scores,
 * lineage, organisation snapshots). The validator accepts both, so a tree
 * written here imports and then fills in the rest.
 */
import { MAPPING_FIELD_ORDER, canonicalSchemaMapping, orderKeys } from '../schema-mapping.js'
import type { LocalizedInput, WriteFile } from './project.js'

export interface ScriptFileSpec {
  /** Path within the entity, e.g. `etl/01_person.sql`. Folders are derived. */
  path: string
  content: string
  /** Ordering within its folder; defaults to declaration order. */
  order?: number
}

export interface SqlCollectionSpec {
  name: LocalizedInput
  description?: LocalizedInput
  files: ScriptFileSpec[]
}

export interface EtlPipelineSpec {
  name: LocalizedInput
  description?: LocalizedInput
  files: ScriptFileSpec[]
  status?: 'draft' | 'ready' | 'running' | 'error'
}

export interface DqCheckSpec {
  name: string
  /** The query the check runs. Without it the check scores nothing. */
  sql: string
  description?: string
  category?: string
  severity?: 'error' | 'warning' | 'info'
  /** Failure threshold; its meaning is the check's own (a count or a ratio). */
  threshold?: number
}

export interface DqRuleSetSpec {
  name: LocalizedInput
  description?: LocalizedInput
  checks: DqCheckSpec[]
}

export interface DataCatalogSpec {
  name: LocalizedInput
  description?: LocalizedInput
  /** Columns the catalog counts over. Empty means it computes nothing. */
  dimensions: string[]
  categoryColumn?: string
  subcategoryColumn?: string
}

export interface ConceptMappingSpec {
  sourceConceptCode: string
  sourceConceptName?: string
  sourceVocabularyId?: string
  sourceDomainId?: string
  sourceCategoryId?: string
  targetConceptId?: number
  targetConceptName?: string
  targetVocabularyId?: string
  targetDomainId?: string
  targetConceptCode?: string
  mappingType?: string
  equivalence?: string
  status?: 'approved' | 'pending' | 'rejected' | 'draft'
}

export interface MappingProjectSpec {
  name: LocalizedInput
  description?: LocalizedInput
  sourceType?: string
  mappings: ConceptMappingSpec[]
}

/**
 * An event table: where a clinical event lives and how to read it.
 *
 * The three required fields are what the app needs to query it at all — which
 * table, which concept column, which date column. The rest are optional
 * because event tables genuinely differ: a measurement has a value and a unit,
 * a condition has neither.
 */
export interface EventTableSpec {
  table: string
  conceptIdColumn: string
  dateColumn: string
  sourceConceptIdColumn?: string
  patientIdColumn?: string
  endDateColumn?: string
  valueColumn?: string
  valueStringColumn?: string
  valueUnitColumn?: string
  valueUnitConceptIdColumn?: string
  routeColumn?: string
  routeConceptIdColumn?: string
  conceptVocabularyColumn?: string
  conceptCodeColumn?: string
  conceptDictionaryKey?: string
}

/**
 * A schema preset: how to read one database's tables.
 *
 * `mapping` is passed through rather than re-typed field by field — it is a
 * large, evolving structure (patient/visit/note/death/visit-detail tables,
 * concept tables, gender values, ERD groups) and re-declaring it here would
 * mean a second definition to keep in step with the app's `SchemaMapping`.
 * What this spec does guarantee is the part that must not drift: the canonical
 * event-table ordering, the DDL split out to its own file, and the required
 * identity fields.
 */
export interface SchemaPresetSpec {
  /** Stable identity of the preset, e.g. `omop-cdm-5-4`. Travels across instances. */
  presetId: string
  /** Human-readable label, shown wherever the schema is picked. */
  presetLabel: LocalizedInput
  description?: LocalizedInput
  /** Event tables keyed by label, e.g. `Measurement`, `Condition`. */
  eventTables?: Record<string, EventTableSpec>
  /**
   * The rest of the mapping (patientTable, visitTable, conceptTables, …),
   * merged as-is. See the app's `SchemaMapping` type for the full shape.
   */
  mapping?: Record<string, unknown>
  /** The CREATE TABLE statements. Written to `schema.ddl`, never inline. */
  ddl?: string
  /** Built-in preset this was derived from, e.g. `omop-5.4`. */
  templateId?: string
  /** User-facing semver; defaults to `0.1.0` like every other entity. */
  version?: string
}

export interface EntitySpecMap {
  'sql-collection': SqlCollectionSpec
  'etl-pipeline': EtlPipelineSpec
  'dq-rule-set': DqRuleSetSpec
  'data-catalog': DataCatalogSpec
  'mapping-project': MappingProjectSpec
  'schema-preset': SchemaPresetSpec
}

export type SerializableEntityKind = keyof EntitySpecMap

const SCRIPT_LANGUAGES: Record<string, string> = {
  py: 'python',
  r: 'r',
  sql: 'sql',
  md: 'markdown',
}

/**
 * JSON exactly as the app's exporters write it: 2-space indent, insertion-order
 * keys, and **no trailing newline**.
 *
 * The newline matters. An authored tree that ends with one differs from what
 * Linkr writes, so the very first sync after an install produces a diff that
 * deletes it — a commit for nothing. Byte-parity with `entity-io.ts`'s `json`
 * and the server's `export_json` is what makes an import land on
 * "nothing to commit".
 */
function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function localized(value: LocalizedInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => typeof v === 'string' && v.length > 0),
  ) as Record<string, string>
}

function sortByPath<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Files + `_tree.json`, with every parent folder declared.
 *
 * A file whose folder is missing from the tree is reparented to the root on
 * import, silently flattening the layout the author built — so the folders are
 * derived here rather than left to the caller to remember.
 */
function serializeScriptFiles(files: ScriptFileSpec[]): WriteFile[] {
  const out: WriteFile[] = files.map((f) => ({ path: f.path, content: f.content }))

  const folders = new Set<string>()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }

  const entries = [
    ...[...folders].map((path) => ({ path, type: 'folder' as const, order: 0, createdAt: '' })),
    ...files.map((f, i) => ({
      path: f.path,
      type: 'file' as const,
      language: SCRIPT_LANGUAGES[f.path.split('.').pop()?.toLowerCase() ?? ''] ?? 'text',
      order: f.order ?? i,
      createdAt: '',
    })),
  ]

  out.push({ path: '_tree.json', content: json(sortByPath(entries)) })
  return sortByPath(out)
}

/** Serialize any standalone entity. Deterministic: same spec → same bytes. */
export function serializeEntity<K extends SerializableEntityKind>(
  kind: K,
  spec: EntitySpecMap[K],
): WriteFile[] {
  switch (kind) {
    case 'sql-collection': {
      const s = spec as SqlCollectionSpec
      return [
        {
          path: '_collection.json',
          content: json({
            name: localized(s.name),
            ...(s.description ? { description: localized(s.description) } : {}),
          }),
        },
        ...serializeScriptFiles(s.files),
      ]
    }

    case 'etl-pipeline': {
      const s = spec as EtlPipelineSpec
      return [
        {
          path: '_pipeline.json',
          content: json({
            name: localized(s.name),
            ...(s.description ? { description: localized(s.description) } : {}),
            status: s.status ?? 'draft',
          }),
        },
        ...serializeScriptFiles(s.files),
      ]
    }

    case 'dq-rule-set': {
      const s = spec as DqRuleSetSpec
      return [
        {
          path: 'rule-set.json',
          content: json({
            name: localized(s.name),
            ...(s.description ? { description: localized(s.description) } : {}),
            status: 'draft',
          }),
        },
        {
          path: 'checks.json',
          content: json(s.checks.map((check, i) => ({
            name: check.name,
            ...(check.description ? { description: check.description } : {}),
            category: check.category ?? 'completeness',
            severity: check.severity ?? 'error',
            ...(check.threshold != null ? { threshold: check.threshold } : {}),
            sql: check.sql,
            order: i,
          }))),
        },
      ]
    }

    case 'data-catalog': {
      const s = spec as DataCatalogSpec
      return [
        {
          path: 'catalog.json',
          content: json({
            name: localized(s.name),
            ...(s.description ? { description: localized(s.description) } : {}),
            dimensions: s.dimensions,
            ...(s.categoryColumn ? { categoryColumn: s.categoryColumn } : {}),
            ...(s.subcategoryColumn ? { subcategoryColumn: s.subcategoryColumn } : {}),
            status: 'draft',
          }),
        },
      ]
    }

    case 'mapping-project': {
      const s = spec as MappingProjectSpec
      return [
        {
          path: 'project.json',
          content: json({
            name: localized(s.name),
            ...(s.description ? { description: localized(s.description) } : {}),
            ...(s.sourceType ? { sourceType: s.sourceType } : {}),
            status: 'draft',
          }),
        },
        {
          path: 'mappings.json',
          // Sorted by source code so a re-export of the same alignments is
          // byte-stable and the git diff shows only real changes.
          content: json([...s.mappings]
            .sort((a, b) => (a.sourceConceptCode < b.sourceConceptCode ? -1
              : a.sourceConceptCode > b.sourceConceptCode ? 1 : 0))
            .map((m) => ({ ...m, status: m.status ?? 'pending' }))),
        },
      ]
    }

    case 'schema-preset': {
      const s = spec as SchemaPresetSpec
      // The DDL is split out to schema.ddl: it is a large text blob, and inline
      // it makes preset.json unreadable in a diff. The validator warns about a
      // mapping that still carries it.
      const { ddl: _inlineDdl, ...rest } = s.mapping ?? {}
      // Ordered on the way out, so re-serializing a preset the app exported
      // reproduces its bytes rather than rearranging the file.
      const mapping = canonicalSchemaMapping(orderKeys({
        presetId: s.presetId,
        presetLabel: localized(s.presetLabel),
        ...rest,
        ...(s.eventTables ? { eventTables: s.eventTables } : {}),
        ...(s.templateId ? { templateId: s.templateId } : {}),
        ...(s.description ? { description: localized(s.description) } : {}),
      }, MAPPING_FIELD_ORDER))
      const ddl = s.ddl ?? (typeof _inlineDdl === 'string' ? _inlineDdl : undefined)
      return [
        {
          path: 'preset.json',
          content: json({
            presetId: s.presetId,
            mapping,
            version: s.version ?? '0.1.0',
          }),
        },
        ...(ddl ? [{ path: 'schema.ddl', content: ddl }] : []),
      ]
    }

    default:
      throw new Error(`Cannot serialize entity kind "${kind}".`)
  }
}
