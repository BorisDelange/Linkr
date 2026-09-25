import type { EntityLicense, GitRemoteConfig, LocalizedString, OrganizationInfo, ProjectBadge } from './index'
import type { Authored, Lineaged } from './author'

/**
 * Schema preset identifier: a free-form slug or uuid.
 *
 * The union used to list the built-in ids alongside `(string & {})`. There are no
 * built-in presets any more — every schema is an installed entity — so the
 * literals named nothing and only offered autocompletion for ids that no longer
 * resolve. Kept as a named type because it documents what the field holds.
 */
export type SchemaPresetId = string

/** A named, colored group of tables displayed on the DDL ERD. */
export interface ErdGroup {
  id: string
  label: string
  /** Tailwind color name: blue | green | orange | purple | teal | red | slate */
  color: string
  /** Table names belonging to this group (case-insensitive matching). */
  tables: string[]
}

/**
 * A column of a relation's source, as the visual form names it: `alias.column`
 * (validated as two identifiers, quoted by the generator), a free SQL expression
 * over the aliases, or a constant.
 */
export type FieldSpec = string | { expr: string } | { value: string | number | boolean | null }

/** A table of the source, under the alias the fields refer to it by. */
export interface RelationTable {
  /** Schema holding the table, for a source published as several (MIMIC-IV
   *  `hosp`/`icu`). Omitted means "wherever the search path finds it". */
  schema?: string
  table: string
  alias: string
}

export interface RelationJoin extends RelationTable {
  type: 'left' | 'inner'
  /** Column pairs, `alias.column` on both sides, ANDed. */
  on: [string, string][]
}

/**
 * How one class relation is read from the source: the visual form (`from`,
 * `joins`, `where`, `fields`), or SQL (`customSql`) — the Cohort "Modified"
 * pattern. Effective SQL = `customSql ?? generate(visual form)`.
 * See docs/planning/schema-classes-plan.md §3-4.
 */
export interface RelationSpec {
  /** The grain table: one row of the class per row of this table. */
  from?: RelationTable
  joins?: RelationJoin[]
  /** SQL filter over the aliases — lets one table feed several relations. */
  where?: string
  /** Contract column → where it comes from. An unmapped column reads NULL. */
  fields?: Record<string, FieldSpec>
  /** SQL written or edited by hand; replaces the generated SQL when set. */
  customSql?: string | null
  /** Contract columns `customSql` fills, as last measured by the contract check.
   *  Unset: the keys of `fields`, plus the required columns. */
  sqlColumns?: string[]
}

export interface PatientSpec extends RelationSpec {
  /**
   * Raw values of `gender_source_value` meaning male / female. The generator
   * turns them into the normalised `gender` column (`male`/`female`/`unknown`)
   * unless `fields.gender` is mapped directly.
   */
  genderValues?: { male: string; female: string; unknown?: string }
}

/** A concept dictionary: one row per concept. Several for MIMIC (d_items, d_labitems…). */
export interface ConceptSpec extends RelationSpec {
  /** Stable key events refer to it by (`concept`, `d_items`). */
  key: string
}

/** An event relation: one row per observation. */
export interface EventSpec extends RelationSpec {
  /** Stable, unique label — cohorts and widgets refer to the relation by it. */
  label: string
  /**
   * Concept dictionary its `concept_id` points into (`ConceptSpec.key`).
   * Omitted: the first dictionary. `'none'`: the relation names its concepts
   * inline (MIMIC `prescriptions.drug`), and `concept_name` defaults to the id.
   */
  conceptDictionaryKey?: string | 'none'
}

export type DrugKind = 'administration' | 'prescription'

/** A drug relation: one row per administration or per prescription line. */
export interface DrugSpec extends EventSpec {
  drugKind: DrugKind
}

/** A value a relation's SQL reads as `{{name}}`, substituted as an escaped
 *  string literal only — never as an identifier or a fragment (plan §7). */
export interface MappingParam {
  default: string
  label?: LocalizedString
  description?: LocalizedString
}

export type SingletonClassKey = 'patient' | 'visit' | 'visitDetail' | 'note'

/**
 * How the app reads a database schema: one relation per class, each honouring
 * its class contract (`lib/schema-classes/contracts.ts`). Every query reads the
 * `linkr_*` relations, never these fields. A v1 mapping (one block per table) is
 * converted on read by `mappingV1ToV2`; only this shape is ever written.
 */
export interface SchemaMapping {
  formatVersion: 2
  presetId: SchemaPresetId
  presetLabel: LocalizedString
  /** Optional human-readable description of the schema, bilingual like the label. */
  description?: LocalizedString

  patient?: PatientSpec
  visit?: RelationSpec
  visitDetail?: RelationSpec
  note?: RelationSpec
  concepts?: ConceptSpec[]
  events?: EventSpec[]
  drugs?: DrugSpec[]

  /** Values relations read as `{{name}}`; a database overrides the values only. */
  params?: Record<string, MappingParam>

  /** Known table names for Parquet folder table name extraction. */
  knownTables?: string[]

  /**
   * Optional DDL (CREATE TABLE statements) for this schema.
   * Used to create empty databases from a preset (e.g., empty OMOP target for ETL),
   * and as the column list the visual editor offers. DuckDB-compatible SQL.
   */
  ddl?: string

  /** ERD group definitions for the DDL diagram. */
  erdGroups?: ErdGroup[]

  /**
   * ERD layout: persisted table positions (table name → { x, y }).
   * When absent, auto-layout is computed from groups.
   */
  erdLayout?: Record<string, { x: number; y: number }>
}

/**
 * What a database changes on top of its preset (plan §7): parameter values, and
 * whole relations replaced for a structural difference. Keys of `relations`:
 * `patient`, `visit`, `visitDetail`, `note`, `concepts.<key>`, `events.<label>`,
 * `drugs.<label>`.
 */
export interface SchemaOverrides {
  params?: Record<string, string>
  relations?: Record<string, RelationSpec>
  /** Fingerprint of the base relation each override was made against
   *  (`relationFingerprint`), to flag an override whose base the preset changed
   *  since. Same keys as `relations`. */
  baseAtOverride?: Record<string, string>
}

/**
 * A custom schema preset stored in IndexedDB.
 * Wraps a SchemaMapping with metadata for persistence.
 */
export interface CustomSchemaPreset extends Authored, Lineaged {
  /** Local primary key, uuid. The row's key on both client and server. */
  id: string
  /** Human-readable, URL-safe identifier. Set once at creation, never changes. */
  entityId: string
  /**
   * RETIRED identity, kept only so rows and trees written before the split stay
   * readable — it played the roles `id` and `entityId` now hold separately.
   * Nothing should read it as an identity: `id` is the key, `entityId` the slug.
   * See docs/planning/schema-preset-identity-plan.md.
   */
  presetId?: string
  workspaceId?: string
  mapping: SchemaMapping
  readme?: LocalizedString
  license?: EntityLicense
  /** Frozen provenance snapshot of the origin organization (inlined on standalone export). Not a live link. */
  organization?: OrganizationInfo
  /** User-facing semver (default '0.1.0'). Portable across export/import. */
  version?: string
  badges?: ProjectBadge[]
  /**
   * Git repository this preset is linked to. When set, workspace export emits only a
   * metadata marker (`schemas/<folder>/_schema.json`) plus a git-links.json pointer;
   * the full preset lives in the linked repo (`preset.json`) and is restored on clone.
   */
  gitRemoteConfig?: GitRemoteConfig
  createdAt: string
  updatedAt: string
}
