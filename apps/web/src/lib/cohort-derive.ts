/**
 * The client side of deriving a cohort into a new database or SQL schema: which
 * databases can receive one, whether a cohort can be derived at all, and the
 * request the server runs (see `apps/api/app/services/data/cohort_derive.py`).
 */
import { ensureUniqueAlias, generateAlias } from '@/lib/alias'
import type { DerivePlanTable, DeriveRequest, DeriveScope, DeriveTableRef } from '@/lib/api/data-sources'
import { buildCohortMembershipSql, conceptEventTables, type RelationNarrowing } from '@/lib/duckdb/cohort-query'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { eventRelations } from '@/lib/schema-classes/relations'
import { fieldColumn, specAt, specTables } from '@/lib/schema-classes/spec'
import { localized } from '@/lib/localized'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import type {
  Cohort, CohortLevel, ConnectionConfig, CriteriaGroupNode, CriteriaTreeNode, DataSource, DatabaseConnectionConfig,
  DerivationOptions, DerivedFrom, LocalizedString, SchemaMapping,
} from '@/types'

/** A SQL schema name the server accepts (`cohort_derive_service._SCHEMA_NAME`). */
export const DERIVE_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/** The external engines a derivation may write into, once the database's owner
 *  allowed it (`allowWrites`). Postgres with the user's own login; SQL Server,
 *  Doris and Oracle with a write login of its own (`WRITE_LOGIN_ENGINES`), their
 *  read logins being read-only. Twin of `cohort_derive_service.WRITABLE_ENGINES`. */
export const WRITABLE_ENGINES: readonly string[] = ['postgresql', 'sqlserver', 'doris', 'oracle']
export const WRITE_LOGIN_ENGINES: readonly string[] = ['sqlserver', 'doris', 'oracle']

/**
 * Whether Linkr may create a SQL schema in this database: a DuckDB file Linkr
 * created, or an external database whose owner allowed Linkr to write. Every
 * other connection stays read-only.
 */
export function isWritableTarget(ds: DataSource): boolean {
  if (ds.sourceType !== 'database' || ds.isVocabularyReference) return false
  const config = ds.connectionConfig as DatabaseConnectionConfig
  if (config.engine === 'duckdb') return !!config.managed
  return WRITABLE_ENGINES.includes(config.engine) && !!config.allowWrites
}

/** The schema name offered for a cohort derived into a SQL schema. */
export function defaultDeriveSchemaName(cohort: Pick<Cohort, 'name'>): string {
  return `cohort_${generateAlias(localized(cohort.name, 'en'))}`.slice(0, 63)
}

/**
 * The row of a new database a cohort of `parent` is derived into, before the
 * job fills it: created first, since the server writes into a database it
 * already knows. A new work in every respect — its caller adds the id, lineage
 * and authorship — carrying the parent's schema, since its tables are the
 * parent's. The parentage is `derivedFrom`, which the server records with the build.
 */
export function derivedDatabaseRow(parent: DataSource, name: LocalizedString, existingAliases: string[]) {
  return {
    alias: ensureUniqueAlias(generateAlias(localized(name, 'en')), existingAliases),
    name,
    description: {},
    sourceType: 'database',
    connectionConfig: { engine: 'duckdb', managed: true } as unknown as ConnectionConfig,
    // The EFFECTIVE mapping (the parent's base with its overrides applied), as
    // the derived database's own base: a subset reads its tables the way the
    // parent did, and has no overrides of its own yet.
    schemaMapping: sanitizeSchemaMapping(parent.schemaMapping),
    ...(parent.schemaSource ? { schemaSource: parent.schemaSource } : {}),
    status: 'configuring',
    workspaceId: parent.workspaceId,
    version: '0.1.0',
  } satisfies Partial<DataSource>
}

/** What a derivation is built from: a cohort, or the snapshot a derived database keeps. */
export type DerivationDefinition = Pick<Cohort, 'level' | 'criteriaTree' | 'customSql' | 'name'>

export type NotDerivable = 'event-level' | 'no-mapping'

/** Why this cohort cannot be derived, or null when it can. */
export function derivableReason(definition: DerivationDefinition, source: DataSource): NotDerivable | null {
  if (definition.level === 'event') return 'event-level'
  if (!source.schemaMapping?.patient) return 'no-mapping'
  if (!buildCohortMembershipSql(definition as Cohort, source.schemaMapping)) return 'no-mapping'
  return null
}

// --- Minimisation and pseudonymisation --------------------------------------

/** The scopes a cohort at `level` can be derived with: its level, or a wider one. */
export function derivationScopes(level: CohortLevel): DeriveScope[] {
  const all: DeriveScope[] = ['patient', 'visit', 'visit_detail']
  const at = all.indexOf(level as DeriveScope)
  return at < 0 ? [] : all.slice(0, at + 1)
}

export const planTableName = (p: { schema: string | null; table: string }) => (p.schema ? `${p.schema}.${p.table}` : p.table)

/** A table a derivation may copy: one never refused as unfilterable. */
export function copyableTables(plan: readonly DerivePlanTable[]): DerivePlanTable[] {
  return plan.filter((p) => !p.unresolved && !p.unfilterable)
}

/** The tables holding no patient data (a vocabulary, the care sites): copied whole. */
export function personlessTables(plan: readonly DerivePlanTable[]): DerivePlanTable[] {
  return copyableTables(plan).filter((p) => !p.filter)
}

/** The tables nothing shows to be personless: never copied unless the user ticks
 *  each one, and then whole, with no filter on the cohort and no id replaced. */
export function unprovenTables(plan: readonly DerivePlanTable[]): DerivePlanTable[] {
  return plan.filter((p) => p.unproven && !p.unresolved)
}

export type VariableSelection = NonNullable<DerivationOptions['variables']>

/**
 * The concept columns of each event table and the concepts it keeps, for a
 * derivation keeping only `variables`. A table is searched as a concept
 * criterion would search it (`conceptEventTables`): one not searched keeps no
 * concept, so it is created empty. `unfiltered`: the event relations whose
 * concept is no plain column of their table (SQL, an expression, a code looked
 * up in a thesaurus) — their table keeps every variable.
 */
export function variableFilters(
  mapping: SchemaMapping,
  variables: VariableSelection,
): { filters: NonNullable<DeriveRequest['variables']>; unfiltered: string[] } {
  const searched = new Set(conceptEventTables(
    { conceptIds: variables.conceptIds, conceptNames: {}, dictionaryKeys: variables.dictionaryKeys },
    mapping,
  ))
  const tables = new Map<string, { schemaName: string | null; table: string; columns: Set<string>; ids: Set<number>; whole: boolean }>()
  const unfiltered: string[] = []
  for (const relation of eventRelations(mapping)) {
    const spec = specAt(mapping, relation.specKey)
    const grain = specTables(spec)[0]
    const label = relation.key ?? relation.name
    if (!grain) {
      unfiltered.push(label)
      continue
    }
    const k = `${grain.schema ?? ''}.${grain.table}`.toLowerCase()
    const entry = tables.get(k) ?? { schemaName: grain.schema ?? null, table: grain.table, columns: new Set(), ids: new Set(), whole: false }
    tables.set(k, entry)
    const onGrain = (field: string) => {
      const c = fieldColumn(spec, field)
      return c && c.table.alias === grain.alias ? c.column : null
    }
    const conceptColumn = onGrain('concept_id')
    if (!conceptColumn || relation.compositeConceptKey) {
      entry.whole = true
      unfiltered.push(label)
      continue
    }
    entry.columns.add(conceptColumn)
    const sourceColumn = onGrain('source_concept_id')
    if (sourceColumn) entry.columns.add(sourceColumn)
    if (relation.key && searched.has(relation.key)) for (const id of variables.conceptIds) entry.ids.add(id)
  }
  const filters = [...tables.values()]
    .filter((t) => !t.whole)
    .map((t) => ({ schemaName: t.schemaName, table: t.table, columns: [...t.columns], conceptIds: [...t.ids] }))
  return { filters, unfiltered }
}

/** The birth date kept to `precision`: the mapped birth date column, truncated
 *  (the server also empties OMOP's day and month of birth beside it). */
export function birthDates(
  mapping: SchemaMapping,
  precision: DerivationOptions['birthPrecision'],
): NonNullable<DeriveRequest['dates']> {
  if (!precision || precision === 'day') return []
  const c = fieldColumn(mapping.patient, 'birth_date')
  return c ? [{ schemaName: c.table.schema ?? null, table: c.table.table, column: c.column, precision }] : []
}

/** Every concept the cohort's enabled criteria name, with their dictionaries —
 *  undefined dictionaries when one criterion does not say. */
export function criteriaConcepts(tree: CriteriaGroupNode | undefined): VariableSelection {
  const ids = new Set<number>()
  const names: Record<number, string> = {}
  const dictionaries = new Set<string>()
  let everyDictionaryKnown = true
  const visit = (node: CriteriaTreeNode) => {
    if (!node.enabled) return
    if (node.kind === 'group') {
      node.children.forEach(visit)
      return
    }
    if (node.type !== 'concept') return
    const config = node.config as { conceptIds?: number[]; conceptNames?: Record<number, string>; dictionaryKeys?: string[] }
    for (const id of config.conceptIds ?? []) {
      ids.add(id)
      if (config.conceptNames?.[id]) names[id] = config.conceptNames[id]
    }
    if (config.dictionaryKeys?.length) config.dictionaryKeys.forEach((k) => dictionaries.add(k))
    else if (config.conceptIds?.length) everyDictionaryKnown = false
  }
  if (tree) visit(tree)
  return {
    conceptIds: [...ids],
    conceptNames: names,
    ...(everyDictionaryKnown && dictionaries.size ? { dictionaryKeys: [...dictionaries] } : {}),
  }
}

/** Two concept selections as one. */
export function mergeVariables(a: VariableSelection | undefined, b: VariableSelection): VariableSelection {
  if (!a) return b
  const known = a.dictionaryKeys && b.dictionaryKeys
  return {
    conceptIds: [...new Set([...a.conceptIds, ...b.conceptIds])],
    conceptNames: { ...a.conceptNames, ...b.conceptNames },
    ...(known ? { dictionaryKeys: [...new Set([...a.dictionaryKeys!, ...b.dictionaryKeys!])] } : {}),
  }
}

/** The request fields `options` stand for, against the mapping of the day. */
function optionFields(options: DerivationOptions, mapping: SchemaMapping): Partial<DeriveRequest> {
  return {
    scope: options.scope as DeriveScope,
    ...(options.tables ? { tables: options.tables.map((t) => ({ schemaName: t.schema, table: t.table })) } : {}),
    ...(options.variables ? { variables: variableFilters(mapping, options.variables).filters } : {}),
    dates: birthDates(mapping, options.birthPrecision),
    ...(options.pseudonymization ? { pseudonymization: options.pseudonymization } : {}),
  }
}

/** The request for a derivation of `source`, without its target. */
export function derivationRequest(input: {
  cohort: DerivationDefinition & { id?: string }
  cohortKey: string
  source: DataSource
  copyPersonless: boolean
  target: DerivedFrom['target']
  /** Each concept searched only in the tables the concept count found it in. */
  narrowing?: RelationNarrowing
  /** What is kept and how it is pseudonymised; absent: everything, as it is. */
  options?: DerivationOptions
  /** The caller's explicit opt-in for this build: stored nowhere a rebuild reads. */
  copyUnprovenTables?: DeriveTableRef[]
}): Omit<DeriveRequest, 'target'> {
  const { cohort, source } = input
  const built = source.schemaMapping ? buildCohortMembershipSql(cohort as Cohort, source.schemaMapping, input.narrowing) : null
  if (!built) throw new Error('this cohort has no membership query')
  // The server runs it on the source as sent, outside queryDataSource.
  const membershipSql = withClassRelations(built, source.schemaMapping)
  const derivedFrom: DerivedFrom = {
    database: {
      ...(source.lineageId ? { lineageId: source.lineageId } : {}),
      ...(source.entityId ? { entityId: source.entityId } : {}),
      label: source.name,
    },
    cohort: { key: input.cohortKey, name: cohort.name },
    level: cohort.level,
    criteriaTree: cohort.criteriaTree,
    ...(cohort.customSql?.trim() ? { customSql: cohort.customSql } : {}),
    target: input.target,
    copyPersonless: input.copyPersonless,
    ...(input.options ? { options: input.options } : {}),
  }
  return {
    membershipSql,
    level: cohort.level,
    copyPersonless: input.copyPersonless,
    ...(cohort.id ? { cohortId: cohort.id } : {}),
    derivedFrom,
    ...(input.options && source.schemaMapping ? optionFields(input.options, source.schemaMapping) : {}),
    ...(input.copyUnprovenTables?.length ? { copyUnprovenTables: input.copyUnprovenTables } : {}),
  }
}

/**
 * The request that rebuilds a derived database from the snapshot it keeps,
 * against `parent` (its `derivedFrom.database`, resolved here). The live cohort
 * is not read: it may have been edited or deleted since.
 */
export function rebuildRequest(
  derived: DataSource,
  parent: DataSource,
  parentCohortId?: string,
): DeriveRequest | null {
  const from = derived.derivedFrom
  if (!from || from.target !== 'new-database') return null
  const definition = { level: from.level, criteriaTree: from.criteriaTree, customSql: from.customSql, name: from.cohort.name }
  if (derivableReason(definition, parent)) return null
  return {
    ...derivationRequest({
      cohort: { ...definition, ...(parentCohortId ? { id: parentCohortId } : {}) },
      cohortKey: from.cohort.key,
      source: parent,
      copyPersonless: from.copyPersonless ?? true,
      target: 'new-database',
      ...(from.options ? { options: from.options } : {}),
    }),
    target: { kind: 'new-database', dataSourceId: derived.id },
  }
}

/**
 * What Linkr created for a database and may remove with it — twin of the
 * server's `created_data`: a DuckDB file it created in a server folder, or the
 * SQL schema a cohort was derived into. Null for a connection someone added
 * (Linkr never made that data), and for a file in Linkr's own folder, which
 * always goes with its database.
 */
export function createdData(ds: DataSource): { kind: 'file'; path: string } | { kind: 'schema'; schema: string } | null {
  const config = ds.connectionConfig as DatabaseConnectionConfig
  if (config.managed && config.managedPath) return { kind: 'file', path: config.managedPath }
  const schema = ds.derivedFrom?.schemaName
  if (schema && config.schema === schema && config.engine && config.engine !== 'duckdb') return { kind: 'schema', schema }
  return null
}
