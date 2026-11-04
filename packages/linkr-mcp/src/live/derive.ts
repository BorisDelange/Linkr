/**
 * Deriving a database from a cohort, as the app's derive dialog does: the
 * request (membership SQL, provenance) comes from the app's own
 * `lib/cohort-derive`, the row of a new database from `derivedDatabaseRow`.
 * Pure: the tool fetches, this decides.
 */
import type { DerivePlanTable, DeriveRequest, DeriveScope } from '@/lib/api/data-sources'
import type { DerivationJobResult, Job } from '@/lib/api/environments'
import { buildCohortKeyMap, cohortKey } from '@/lib/cohort-key'
import {
  DERIVE_SCHEMA_NAME, copyableTables, criteriaConcepts, defaultDeriveSchemaName, derivableReason, derivationRequest,
  derivationScopes, derivedDatabaseRow, isWritableTarget, personlessTables, planTableName, type NotDerivable,
} from '@/lib/cohort-derive'
import type { Cohort, DataSource, DatabaseConnectionConfig, DerivationOptions } from '@/types'

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
  'event-level': 'it is an event-level cohort; derive a patient, visit or visit_detail cohort',
  'no-mapping': 'its database has no patient table in its schema mapping, or the criteria produce no membership query',
}

/** What the agent asks a derivation to keep and how to pseudonymise it; every
 *  field absent takes the app's default. */
export interface DeriveOptionsInput {
  scope?: DeriveScope
  /** Table names as the plan lists them; absent: every copyable one. */
  tables?: string[]
  copyPersonless?: boolean
  /** `criteria`: the concepts the cohort's criteria name. */
  variables?: 'all' | 'criteria' | number[]
  birthPrecision?: 'year' | 'month' | 'day'
  pseudonymize?: boolean
  method?: 'hmac' | 'random'
  keepKey?: boolean
  reuseKeyOf?: string
  correspondence?: { databaseId: string; schemaName?: string; tableName?: string }
}

/**
 * The derivation options the dialog would send for these choices, against the
 * plan read for `scope`. As in the app: pseudonymised (keyed hash, key kept)
 * and birth dates to the month unless told otherwise — the CNIL referential asks
 * each project's data for pseudonyms of its own.
 */
export function derivationOptions(
  cohort: Pick<Cohort, 'level' | 'criteriaTree'>,
  plan: readonly DerivePlanTable[],
  input: DeriveOptionsInput,
): { options: DerivationOptions; copyPersonless: boolean } | { error: string } {
  const scope = input.scope ?? (cohort.level as DeriveScope)
  if (!derivationScopes(cohort.level).includes(scope)) {
    return { error: `A ${cohort.level} cohort keeps its ${cohort.level}s or a wider scope: ${derivationScopes(cohort.level).join(', ')}.` }
  }
  const copyable = copyableTables(plan)
  const personless = new Set(personlessTables(plan).map(planTableName))
  let kept = copyable
  if (input.tables) {
    const known = new Map(copyable.map((p) => [planTableName(p).toLowerCase(), p]))
    const unknown = input.tables.filter((n) => !known.has(n.toLowerCase()))
    if (unknown.length) return { error: `Not a table this derivation can copy: ${unknown.join(', ')} (see plan_cohort_derivation).` }
    const wanted = new Set(input.tables.map((n) => n.toLowerCase()))
    kept = copyable.filter((p) => wanted.has(planTableName(p).toLowerCase()))
  } else if (input.copyPersonless === false) {
    kept = copyable.filter((p) => !personless.has(planTableName(p)))
  }
  if (kept.length === 0) return { error: 'No table left to copy.' }

  let variables: DerivationOptions['variables']
  if (input.variables === 'criteria') {
    variables = criteriaConcepts(cohort.criteriaTree)
    if (!variables.conceptIds.length) return { error: 'The cohort\'s criteria name no concept: keep every variable, or list concept ids.' }
  } else if (Array.isArray(input.variables)) {
    if (!input.variables.length) return { error: 'List at least one concept id, or keep every variable.' }
    variables = { conceptIds: [...new Set(input.variables)], conceptNames: {} }
  }

  const birthPrecision = input.birthPrecision ?? 'month'
  const method = input.method ?? 'hmac'
  if (input.reuseKeyOf && method !== 'hmac') return { error: 'Only a keyed hash (method hmac) can reuse another derivation\'s key.' }
  const c = input.correspondence
  const correspondence = c && {
    dataSourceId: c.databaseId, schemaName: c.schemaName ?? 'pseudonyms', tableName: c.tableName ?? 'linkr_pseudonyms',
  }
  if (correspondence && !(DERIVE_SCHEMA_NAME.test(correspondence.schemaName) && DERIVE_SCHEMA_NAME.test(correspondence.tableName))) {
    return { error: 'The correspondence schema and table: lowercase letters, digits and underscores, starting with a letter or _.' }
  }
  return {
    copyPersonless: [...personless].every((n) => kept.some((p) => planTableName(p) === n)),
    options: {
      scope,
      tables: kept.map((p) => ({ schema: p.schema, table: p.table })),
      ...(variables ? { variables } : {}),
      ...(birthPrecision !== 'day' ? { birthPrecision } : {}),
      ...(input.pseudonymize ?? true ? {
        pseudonymization: {
          method,
          keepKey: method === 'hmac' && (input.keepKey ?? true),
          ...(method === 'hmac' && input.reuseKeyOf ? { reuseKeyOf: input.reuseKeyOf } : {}),
          ...(correspondence ? { correspondence } : {}),
        },
      } : {}),
    },
  }
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
  /** What is kept and how it is pseudonymised (`derivationOptions`); absent: everything, as it is. */
  options?: DerivationOptions
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
    options: input.options,
  })

  const correspondence = input.options?.pseudonymization?.correspondence?.dataSourceId
  if (correspondence) {
    const into = input.databases.find((d) => d.id === correspondence)
    if (!into || into.workspaceId !== source.workspaceId || !isWritableTarget(into)) {
      return { error: `Database ${correspondence} cannot hold the correspondence table: it must be a writable database of the same workspace.` }
    }
    if (into.id === source.id && (source.connectionConfig as DatabaseConnectionConfig).engine === 'duckdb') {
      return { error: 'The correspondence table cannot go into the DuckDB file the cohort is read from.' }
    }
  }

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
        + 'or a Postgres, SQL Server, Doris or Oracle database whose connection allows writes. Derive into a new database instead.',
    }
  }
  const schemaName = target.schemaName ?? defaultDeriveSchemaName(cohort)
  if (!DERIVE_SCHEMA_NAME.test(schemaName)) {
    return { error: `Invalid schema name "${schemaName}": lowercase letters, digits and underscores, starting with a letter or _.` }
  }
  // A schema of a server database can also be declared as a database of its own.
  const external = (into.connectionConfig as DatabaseConnectionConfig).engine !== 'duckdb'
  if (correspondence === into.id) return { error: 'The correspondence table cannot go into the database derived into.' }
  const register = external && (target.register ?? true)
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
  const whole = tables.filter((t) => !t.filter && !t.unresolved && !t.unfilterable)
  const unresolved = tables.filter((t) => !t.filter && t.unresolved)
  const unfilterable = tables.filter((t) => t.unfilterable && !t.unresolved)
  const lines = [`${filtered.length} table(s) filtered on the cohort, ${whole.length} without a patient id:`]
  for (const t of filtered) lines.push(`- ${tableName(t)}: ${FILTER_WORDS[t.filter!]} (${t.column})`)
  for (const t of whole) lines.push(`- ${tableName(t)}: ${copyPersonless ? 'copied whole' : 'skipped'}`)
  for (const t of unresolved) {
    lines.push(`- ${tableName(t)}: skipped — relation ${t.unresolved} reads it without a patient id column, so it cannot be filtered`)
  }
  for (const t of unfilterable) {
    lines.push(`- ${tableName(t)}: skipped — it carries ${t.unfilterable}, which this scope keeps no set of, so it cannot be filtered`)
  }
  const ids = [...new Set(tables.filter((t) => !t.unresolved && !t.unfilterable).flatMap((t) => t.pseudonymized ?? []))]
  if (ids.length) lines.push('', `Id columns a pseudonymised derivation replaces: ${ids.join(', ')}.`)
  return lines.join('\n')
}

/** The longest a get_job_status call waits: under the usual 60 s tool-call timeout of MCP clients. */
export const MAX_JOB_WAIT_SECONDS = 50

const pending = (job: Job) => job.status === 'queued' || job.status === 'running'

/**
 * The job once it has ended, or as it stands after `waitSeconds`. An agent cannot
 * wait between two calls: without this it polls, and every poll re-sends its whole
 * conversation to the model.
 */
export async function waitForJob(
  read: () => Promise<Job>, waitSeconds: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), stepMs = 2000,
): Promise<Job> {
  const deadline = Date.now() + Math.max(0, Math.min(MAX_JOB_WAIT_SECONDS, waitSeconds)) * 1000
  let job = await read()
  while (pending(job) && Date.now() + stepMs <= deadline) {
    await sleep(stepMs)
    job = await read()
  }
  return job
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
    lines.push(`Still in progress${job.kind === 'derive' ? ' (a copy of a large database takes minutes)' : ''}: `
      + `call get_job_status again with wait_seconds: ${MAX_JOB_WAIT_SECONDS} to wait for it in one call.`)
  } else if (job.status === 'error' && job.kind === 'derive') {
    lines.push('Failed. A database created for this derivation was removed again.')
  }
  const log = job.logTail?.split('\n').filter(Boolean).slice(-8) ?? []
  if (log.length) lines.push('', 'Log (last lines):', ...log.map((l) => `  ${l}`))
  return lines.join('\n')
}
