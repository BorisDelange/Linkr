/**
 * Serialize the standalone entities: SQL collection, ETL pipeline, DQ rule set,
 * data catalog, mapping project.
 *
 * Same contract as `serialize/project.ts` — a spec in, `{ path, content }` pairs
 * out, no I/O — so one caller can write any kind to disk, a ZIP, or anywhere
 * else. Each spec is a **simplified authoring view**: it carries what an author
 * supplies, not every field the app later attaches (run timestamps, scores,
 * lineage, organisation snapshots). The validator accepts both, so a tree
 * written here imports and then fills in the rest.
 */
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

export interface EntitySpecMap {
  'sql-collection': SqlCollectionSpec
  'etl-pipeline': EtlPipelineSpec
  'dq-rule-set': DqRuleSetSpec
  'data-catalog': DataCatalogSpec
  'mapping-project': MappingProjectSpec
}

export type SerializableEntityKind = keyof EntitySpecMap

const SCRIPT_LANGUAGES: Record<string, string> = {
  py: 'python',
  r: 'r',
  sql: 'sql',
  md: 'markdown',
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
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

    default:
      throw new Error(`Cannot serialize entity kind "${kind}".`)
  }
}
