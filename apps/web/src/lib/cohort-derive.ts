/**
 * The client side of deriving a cohort into a new database or SQL schema: which
 * databases can receive one, whether a cohort can be derived at all, and the
 * request the server runs (see `apps/api/app/services/data/cohort_derive.py`).
 */
import { ensureUniqueAlias, generateAlias } from '@/lib/alias'
import type { DeriveRequest } from '@/lib/api/data-sources'
import { buildCohortMembershipSql } from '@/lib/duckdb/cohort-query'
import { localized } from '@/lib/localized'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import type {
  Cohort, ConnectionConfig, DataSource, DatabaseConnectionConfig, DerivedFrom, LocalizedString,
} from '@/types'

/** A SQL schema name the server accepts (`cohort_derive_service._SCHEMA_NAME`). */
export const DERIVE_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Whether Linkr may create a SQL schema in this database: a DuckDB file Linkr
 * created, or a Postgres whose owner allowed Linkr to write. Every other
 * connection stays read-only.
 */
export function isWritableTarget(ds: DataSource): boolean {
  if (ds.sourceType !== 'database' || ds.isVocabularyReference) return false
  const config = ds.connectionConfig as DatabaseConnectionConfig
  if (config.engine === 'duckdb') return !!config.managed
  if (config.engine === 'postgresql') return !!config.allowWrites
  return false
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
    schemaMapping: sanitizeSchemaMapping(parent.schemaMapping),
    ...(parent.schemaSource ? { schemaSource: parent.schemaSource } : {}),
    status: 'configuring',
    workspaceId: parent.workspaceId,
    version: '0.1.0',
  } satisfies Partial<DataSource>
}

/** What a derivation is built from: a cohort, or the snapshot a derived database keeps. */
export type DerivationDefinition = Pick<Cohort, 'level' | 'criteriaTree' | 'customSql' | 'name'>

export type NotDerivable = 'custom-sql' | 'event-level' | 'no-mapping'

/** Why this cohort cannot be derived, or null when it can. */
export function derivableReason(definition: DerivationDefinition, source: DataSource): NotDerivable | null {
  // The membership is rebuilt from the criteria; a hand-written query returns
  // rows in no known shape, so there is nothing to filter the tables on.
  if (definition.customSql) return 'custom-sql'
  if (definition.level === 'event') return 'event-level'
  if (!source.schemaMapping?.patientTable) return 'no-mapping'
  if (!buildCohortMembershipSql(definition as Cohort, source.schemaMapping)) return 'no-mapping'
  return null
}

/** The request for a derivation of `source`, without its target. */
export function derivationRequest(input: {
  cohort: DerivationDefinition & { id?: string }
  cohortKey: string
  source: DataSource
  copyPersonless: boolean
  target: DerivedFrom['target']
}): Omit<DeriveRequest, 'target'> {
  const { cohort, source } = input
  const membershipSql = source.schemaMapping ? buildCohortMembershipSql(cohort as Cohort, source.schemaMapping) : null
  if (!membershipSql) throw new Error('this cohort has no membership query')
  const derivedFrom: DerivedFrom = {
    database: {
      ...(source.lineageId ? { lineageId: source.lineageId } : {}),
      ...(source.entityId ? { entityId: source.entityId } : {}),
      label: source.name,
    },
    cohort: { key: input.cohortKey, name: cohort.name },
    level: cohort.level,
    criteriaTree: cohort.criteriaTree,
    target: input.target,
    copyPersonless: input.copyPersonless,
  }
  return {
    membershipSql,
    level: cohort.level,
    copyPersonless: input.copyPersonless,
    ...(cohort.id ? { cohortId: cohort.id } : {}),
    derivedFrom,
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
