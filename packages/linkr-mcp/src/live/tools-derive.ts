/** Databases derived from a cohort, and the jobs that build them. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { derivableReason } from '@/lib/cohort-derive'
import type { Cohort, DataSource as WebDataSource } from '@/types'
import { NOT_DERIVABLE, formatDerivePlan, formatJob, planDerivation, type DeriveTargetInput } from './derive.js'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, projectDatabases, text, type Server,
} from './shared.js'

/** The database a cohort runs on — the one owning it, its own, else its
 *  project's first usable one (as the app does). */
async function cohortSource(cohort: Cohort): Promise<WebDataSource> {
  let id = cohort.ownerDataSourceId ?? cohort.dataSourceId
  if (!id && cohort.projectUid) {
    const dbs = await projectDatabases(cohort.projectUid)
    id = dbs.find((d) => d.status === 'connected' && d.schemaMapping?.patientTable)?.id
  }
  if (!id) throw new Error('This cohort has no database to derive from.')
  return await api.getDataSource(id) as unknown as WebDataSource
}

const siblingsOf = (cohort: Cohort) =>
  cohort.ownerDataSourceId ? api.listDatabaseCohorts(cohort.ownerDataSourceId)
    : cohort.projectUid ? api.listCohorts(cohort.projectUid) : Promise.resolve([cohort])

export function registerDeriveTools(server: Server): void {
  server.registerTool('list_database_cohorts', {
    description:
      'List the cohorts that belong to a database itself (the Databases page\'s cohorts, not a project\'s) — '
      + 'the ones the app offers to derive a database from.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ database_id: string }>({
      type: 'object', properties: { database_id: { type: 'string' } }, required: ['database_id'],
    }),
  }, guard(async ({ database_id }) => {
    const cohorts = await api.listDatabaseCohorts(database_id)
    if (cohorts.length === 0) return text('No cohort in this database.')
    return text(cohorts.map((c) => `- "${loc(c.name)}" — cohort_id: ${c.id} · level ${c.level}`
      + `${c.resultCount != null ? ` · last count ${c.resultCount}` : ''}`
      + `${c.derivations?.length ? ` · derived into ${c.derivations.map((d) => d.schemaName ? `${d.targetId}.${d.schemaName}` : d.targetId).join(', ')}` : ''}`).join('\n'))
  }))

  server.registerTool('plan_cohort_derivation', {
    description:
      'Before derive_database_from_cohort: whether a cohort can be derived, and what the copy would do with each '
      + 'table of its database (filtered on the cohort\'s patients / visits, or copied whole). Reads nothing but the schema.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ cohort_id: string; copy_personless?: boolean }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        copy_personless: { type: 'boolean', description: 'Copy the tables with no patient id (vocabularies…) whole. Default true.' },
      },
      required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id, copy_personless }) => {
    const cohort = await api.getCohort(cohort_id)
    const source = await cohortSource(cohort)
    const reason = derivableReason(cohort, source)
    if (reason) return failure(`This cohort cannot be derived: ${NOT_DERIVABLE[reason]}.`)
    const tables = await api.derivePlan(source.id, cohort.level)
    return text(`Deriving "${loc(cohort.name)}" (${cohort.level}) from database ${source.id} "${loc(source.name)}":\n`
      + formatDerivePlan(tables, copy_personless ?? true))
  }))

  server.registerTool('derive_database_from_cohort', {
    description:
      'Create a database restricted to a cohort\'s patients: the app\'s "Derive" action. Copies every table of the '
      + 'cohort\'s database, filtered on the cohort, into a NEW Linkr database (default) or a new SQL schema of a '
      + 'writable database. The copy runs as a server job and takes minutes on a large database: this returns at '
      + 'once with the job id — follow it with get_job_status, which gives the new database id when done. '
      + 'The cohort must be built from criteria (not custom SQL) at patient, visit or visit_detail level. '
      + 'A cohort of the database itself (list_database_cohorts) records the derivation on the cohort, as in the app; '
      + 'a project cohort derives from the database it runs on, unrecorded.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      cohort_id: string; target?: 'new-database' | 'schema'; name?: string; path?: string; rebuild_database_id?: string
      target_database_id?: string; schema_name?: string; replace?: boolean; register?: boolean; copy_personless?: boolean
    }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        target: { type: 'string', enum: ['new-database', 'schema'], description: 'Default new-database.' },
        name: {
          type: 'string',
          description: 'new-database: the new database\'s name (default: the cohort\'s). schema on Postgres: the name it is declared under.',
        },
        path: {
          type: 'string',
          description: 'new-database: a new .duckdb file on the server (absolute path, inside the allowed folders). Default: Linkr\'s data folder.',
        },
        rebuild_database_id: {
          type: 'string',
          description: 'new-database: rebuild this database, derived from the cohort before, instead of creating one (its content is replaced).',
        },
        target_database_id: {
          type: 'string',
          description: 'schema: the database receiving the schema — a DuckDB Linkr created, or a Postgres allowing writes. Default: the cohort\'s database.',
        },
        schema_name: { type: 'string', description: 'schema: lowercase identifier. Default cohort_<cohort name>.' },
        replace: { type: 'boolean', description: 'schema: drop and recreate the schema if it exists (a rebuild). Default false.' },
        register: { type: 'boolean', description: 'schema on Postgres: also declare the schema as a Linkr database. Default true.' },
        copy_personless: { type: 'boolean', description: 'Copy the tables with no patient id (vocabularies…) whole. Default true.' },
      },
      required: ['cohort_id'],
    }),
  }, guard(async (args) => {
    const cohort = await api.getCohort(args.cohort_id)
    const source = await cohortSource(cohort)
    const [siblings, databases] = await Promise.all([siblingsOf(cohort), api.listDataSources()])
    const target: DeriveTargetInput = args.target === 'schema'
      ? {
          kind: 'schema', databaseId: args.target_database_id, schemaName: args.schema_name,
          replace: args.replace, register: args.register, name: args.name,
        }
      : { kind: 'new-database', name: args.name, path: args.path, rebuildId: args.rebuild_database_id }
    const plan = planDerivation({
      cohort,
      source,
      siblings,
      databases: databases as unknown as WebDataSource[],
      target,
      copyPersonless: args.copy_personless ?? true,
      newId: randomUUID(),
      lineageId: randomUUID(),
    })
    if ('error' in plan) return failure(plan.error)

    // As the app: the new database's row first (the server writes into a
    // database it knows), removed again when the derivation is refused.
    const created = plan.create ? await api.createDataSource(plan.create) : undefined
    let job
    try {
      job = await api.derive(plan.sourceId, plan.request)
    } catch (e) {
      if (created) await api.deleteDataSource(created.id).catch(() => {})
      throw e
    }
    const into = plan.request.target
    const where = into.kind === 'schema'
      ? `schema ${into.schemaName} of database ${into.dataSourceId}`
      : `${created ? 'new ' : ''}database ${into.dataSourceId}${created ? ` "${loc(created.name)}" (status "configuring" until the job ends)` : ''}`
    return text([
      `Derivation of "${loc(cohort.name)}" started into ${where}.`,
      `job_id: ${job.id} (${job.status})`,
      'The copy runs on the server and can take several minutes. Call get_job_status with this job_id to follow it; '
        + 'when done it gives the database id to query. The user sees it in Linkr\'s jobs panel and notifications.',
      ...(into.kind === 'schema' && !into.registerName ? ['The schema is read through the target database (e.g. run_sql on it, qualified by the schema).'] : []),
    ].join('\n'))
  }))

  server.registerTool('get_job_status', {
    description:
      'Status of a server job the user started (a derivation from derive_database_from_cohort): queued / running / '
      + 'done / error / cancelled, progress, last log lines, and for a finished derivation the database id and counts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ job_id: string }>({
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'],
    }),
  }, guard(async ({ job_id }) => text(formatJob(await api.getJob(job_id)))))

  server.registerTool('cancel_job', {
    description: 'Cancel a running job the user started. A cancelled first build removes the database made for it.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ job_id: string }>({
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'],
    }),
  }, guard(async ({ job_id }) => {
    await api.cancelJob(job_id)
    return text(formatJob(await api.getJob(job_id)))
  }))
}
