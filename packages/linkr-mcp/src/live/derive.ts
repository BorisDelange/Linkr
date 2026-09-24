/**
 * Deriving a database from a cohort, as the app's derive dialog does: the
 * request (membership SQL, provenance) comes from the app's own
 * `lib/cohort-derive`, the row of a new database from `derivedDatabaseRow`.
 * Pure: the tool fetches, this decides.
 */
import type { DerivePlanTable, DeriveRequest } from '@/lib/api/data-sources'
import type { DerivationJobResult, Job } from '@/lib/api/environments'
import { buildCohortKeyMap, cohortKey } from '@/lib/cohort-key'
import {
  DERIVE_SCHEMA_NAME, defaultDeriveSchemaName, derivableReason, derivationRequest, derivedDatabaseRow,
  isWritableTarget, type NotDerivable,
} from '@/lib/cohort-derive'
import type { Cohort, DataSource, DatabaseConnectionConfig } from '@/types'

export type DeriveTargetInput =
  /** A new Linkr-owned DuckDB database; `rebuildId` rebuilds one derived before instead. */
  | { kind: 'new-database'; name?: string; path?: string; rebuildId?: string }
  /** A new SQL schema in a writable database (default: the source, when writable). */
  | { kind: 'schema'; databaseId?: string; schemaName?: string; replace?: boolean; register?: boolean; name?: string }

export interface DerivationPlan {
  /** The database the copy reads. */
  sourceId: string
  /** Body of `POST /data-sources` for the new database, when one must be created first. */
  create?: Record<string, unknown>
  request: DeriveRequest
}

export const NOT_DERIVABLE: Record<NotDerivable, string> = {
  'custom-sql': 'it is defined by custom SQL; only a cohort built from criteria can be derived (the copy is filtered on its membership)',
  'event-level': 'it is an event-level cohort; derive a patient, visit or visit_detail cohort',
  'no-mapping': 'its database has no patient table in its schema mapping, or the criteria produce no membership query',
}

/**
 * What deriving `cohort` does, or why it cannot: the app's refusals, in words a
 * model can act on. `databases` is what the caller can see — the target and the
 * aliases a new database must not collide with.
 */
export function planDerivation(input: {
  cohort: Cohort
  source: DataSource
  /** The cohort's siblings (its database's cohorts, or its project's), for its export key. */
  siblings: Cohort[]
  databases: DataSource[]
  target: DeriveTargetInput
  copyPersonless: boolean
  /** Ids for a new database row. */
  newId: string
  lineageId: string
}): DerivationPlan | { error: string } {
  const { cohort, source, target } = input
  if (!source.workspaceId) return { error: 'Only a database of a workspace can be derived.' }
  if (source.status !== 'connected') return { error: `The cohort's database is not connected (status ${source.status}).` }
  const reason = derivableReason(cohort, source)
  if (reason) return { error: `This cohort cannot be derived: ${NOT_DERIVABLE[reason]}.` }

  // Recorded on the cohort only when it is one of the database's own: the
  // server refuses any other (a project cohort derives, unrecorded).
  const owned = cohort.ownerDataSourceId === source.id
  const key = buildCohortKeyMap(input.siblings).get(cohort.id) ?? cohortKey(cohort)
  const base = derivationRequest({
    cohort: owned ? cohort : { ...cohort, id: undefined },
    cohortKey: key,
    source,
    copyPersonless: input.copyPersonless,
    target: target.kind,
  })

  if (target.kind === 'new-database') {
    if (target.rebuildId) {
      const existing = input.databases.find((d) => d.id === target.rebuildId)
      if (!existing) return { error: `Database ${target.rebuildId} not found.` }
      if (existing.derivedFrom?.target !== 'new-database') {
        return { error: `Database ${target.rebuildId} was not derived from a cohort into a new database; it cannot be rebuilt.` }
      }
      return { sourceId: source.id, request: { ...base, target: { kind: 'new-database', dataSourceId: existing.id } } }
    }
    const name = target.name?.trim() || cohort.name
    const localizedName = typeof name === 'string' ? { en: name } : name
    const aliases = input.databases.map((d) => d.alias).filter(Boolean)
    return {
      sourceId: source.id,
      create: { id: input.newId, ...derivedDatabaseRow(source, localizedName, aliases), lineageId: input.lineageId },
      request: {
        ...base,
        target: { kind: 'new-database', dataSourceId: input.newId, ...(target.path ? { path: target.path } : {}) },
      },
    }
  }

  const into = target.databaseId ? input.databases.find((d) => d.id === target.databaseId) : source
  if (!into) return { error: `Database ${target.databaseId} not found.` }
  if (into.workspaceId !== source.workspaceId) return { error: 'The target database must be in the same workspace as the cohort\'s.' }
  if (!isWritableTarget(into)) {
    return {
      error: `Linkr may not create a schema in "${nameOf(into)}": it must be a DuckDB database Linkr created, `
        + 'or a Postgres database whose connection allows writes. Derive into a new database instead.',
    }
  }
  const schemaName = target.schemaName ?? defaultDeriveSchemaName(cohort)
  if (!DERIVE_SCHEMA_NAME.test(schemaName)) {
    return { error: `Invalid schema name "${schemaName}": lowercase letters, digits and underscores, starting with a letter or _.` }
  }
  const postgres = (into.connectionConfig as DatabaseConnectionConfig).engine === 'postgresql'
  const register = postgres && (target.register ?? true)
  return {
    sourceId: source.id,
    request: {
      ...base,
      target: {
        kind: 'schema',
        dataSourceId: into.id,
        schemaName,
        ...(target.replace ? { replace: true } : {}),
        ...(register ? { registerName: target.name?.trim() || schemaName, registerAlias: schemaName } : {}),
      },
    },
  }
}

const nameOf = (d: Pick<DataSource, 'name'>) =>
  typeof d.name === 'string' ? d.name : d.name?.en ?? Object.values(d.name ?? {})[0] ?? ''

const tableName = (p: { schema: string | null; table: string }) => (p.schema ? `${p.schema}.${p.table}` : p.table)

const FILTER_WORDS: Record<NonNullable<DerivePlanTable['filter']>, string> = {
  patient: 'rows of the cohort\'s patients',
  visit: 'rows of the cohort\'s visits',
  visit_detail: 'rows of the cohort\'s unit stays',
  parent_visit: 'rows of the visits holding the cohort\'s unit stays',
}

/** What the copy will do with each table, as the dialog lists it. */
export function formatDerivePlan(tables: DerivePlanTable[], copyPersonless: boolean): string {
  const filtered = tables.filter((t) => t.filter)
  const whole = tables.filter((t) => !t.filter)
  const lines = [`${filtered.length} table(s) filtered on the cohort, ${whole.length} without a patient id:`]
  for (const t of filtered) lines.push(`- ${tableName(t)}: ${FILTER_WORDS[t.filter!]} (${t.column})`)
  for (const t of whole) lines.push(`- ${tableName(t)}: ${copyPersonless ? 'copied whole' : 'skipped'}`)
  return lines.join('\n')
}

/** A job as the agent reads it: where it is, and on success what it produced. */
export function formatJob(job: Job): string {
  const lines = [`Job ${job.id} (${job.kind}) "${job.label}": ${job.status}, ${job.progress}%`]
  const result = job.result as unknown as (DerivationJobResult & { tables?: { skipped: boolean }[] }) | null | undefined
  if (job.status === 'done' && job.kind === 'derive' && result) {
    const copied = result.tables?.filter((t) => !t.skipped).length
    lines.push(
      `Database ready: database_id ${result.dataSourceId ?? result.targetId} — ${result.patientCount} patient(s), `
        + `${result.unitCount} cohort row(s)${copied != null ? `, ${copied} table(s) copied` : ''}.`,
      'Query it with describe_database / run_sql.',
    )
  } else if (job.status === 'queued' || job.status === 'running') {
    lines.push('Still in progress: check again in a minute (a copy of a large database takes minutes).')
  } else if (job.status === 'error' && job.kind === 'derive') {
    lines.push('Failed. A database created for this derivation was removed again.')
  }
  const log = job.logTail?.split('\n').filter(Boolean).slice(-8) ?? []
  if (log.length) lines.push('', 'Log (last lines):', ...log.map((l) => `  ${l}`))
  return lines.join('\n')
}
