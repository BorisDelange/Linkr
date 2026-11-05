/** Databases derived from a cohort, and the jobs that build them. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { derivableReason } from '@/lib/cohort-derive'
import type { Cohort, DataSource as WebDataSource } from '@/types'
import {
  MAX_JOB_WAIT_SECONDS, NOT_DERIVABLE, derivationOptions, formatDerivePlan, formatJob, planDerivation, waitForJob,
  type DeriveOptionsInput, type DeriveTargetInput,
} from './derive.js'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, projectDatabases, text, type Server,
} from './shared.js'

/** The database a cohort runs on — the one owning it, its own, else its
 *  project's first usable one (as the app does). */
async function cohortSource(cohort: Cohort): Promise<WebDataSource> {
  let id = cohort.ownerDataSourceId ?? cohort.dataSourceId
  if (!id && cohort.projectUid) {
    const dbs = await projectDatabases(cohort.projectUid)
    id = dbs.find((d) => d.status === 'connected' && d.schemaMapping?.patient)?.id
  }
  if (!id) throw new Error('This cohort has no database to derive from.')
  return await api.getDataSource(id) as unknown as WebDataSource
}

const SCOPE_DESCRIPTION = 'The individuals kept: the cohort\'s level (default) or a wider one — a visit cohort may keep '
  + 'its patients\' every visit (patient). Never a narrower one.'

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
      + `${c.derivations?.length ? ` · derived into ${c.derivations.map((d) => (d.schemaName ? `${d.targetId}.${d.schemaName}` : d.targetId)
        + (d.derivationId && d.options?.pseudonymization?.method === 'hmac' && d.options.pseudonymization.keepKey
          ? ` (key kept: reuse_key_of ${d.derivationId})` : '')).join(', ')}` : ''}`).join('\n'))
  }))

  server.registerTool('plan_cohort_derivation', {
    description:
      'Before derive_database_from_cohort: whether a cohort can be derived, and what the copy would do with each '
      + 'table of its database (filtered on the cohort\'s patients / visits, copied whole, or skipped) and which id columns '
      + 'pseudonymisation replaces. The table names it lists are the ones derive_database_from_cohort\'s `tables` takes. '
      + 'Reads nothing but the schema.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ cohort_id: string; scope?: string; copy_personless?: boolean }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        scope: { type: 'string', enum: ['patient', 'visit', 'visit_detail'], description: SCOPE_DESCRIPTION },
        copy_personless: { type: 'boolean', description: 'Copy the tables with no patient id (vocabularies…) whole. Default true.' },
      },
      required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id, scope, copy_personless }) => {
    const cohort = await api.getCohort(cohort_id)
    const source = await cohortSource(cohort)
    const reason = derivableReason(cohort, source)
    if (reason) return failure(`This cohort cannot be derived: ${NOT_DERIVABLE[reason]}.`)
    const tables = await api.derivePlan(source.id, cohort.level, scope)
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
      + 'a project cohort derives from the database it runs on, unrecorded. '
      + 'As in the app, by default the ids are pseudonymised (keyed hash, key kept sealed in Linkr) and birth dates '
      + 'kept to the month; minimise further with scope, tables and variables. Writing into SQL Server, Doris or '
      + 'Oracle uses a write account of the user\'s own, which they enter in Linkr — never in this conversation.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      cohort_id: string; target?: 'new-database' | 'schema'; name?: string; path?: string; rebuild_database_id?: string
      target_database_id?: string; schema_name?: string; replace?: boolean; register?: boolean; copy_personless?: boolean
      scope?: 'patient' | 'visit' | 'visit_detail'; tables?: string[]; variables?: 'all' | 'criteria' | 'concepts'; concept_ids?: number[]
      birth_precision?: 'year' | 'month' | 'day'; pseudonymize?: boolean; method?: 'hmac' | 'random'; keep_key?: boolean
      reuse_key_of?: string; correspondence_database_id?: string; correspondence_schema?: string; correspondence_table?: string
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
          description: 'schema: the database receiving the schema — a DuckDB Linkr created, or a Postgres, SQL Server, Doris or '
            + 'Oracle database allowing writes (Oracle: an existing empty schema, created by an administrator). Default: the cohort\'s database.',
        },
        schema_name: { type: 'string', description: 'schema: lowercase identifier. Default cohort_<cohort name>.' },
        replace: { type: 'boolean', description: 'schema: drop and recreate the schema if it exists (a rebuild). Default false.' },
        register: { type: 'boolean', description: 'schema outside DuckDB: also declare the schema as a Linkr database. Default true.' },
        copy_personless: {
          type: 'boolean', description: 'Copy the tables with no patient id (vocabularies…) whole. Default true. Ignored with tables.',
        },
        scope: { type: 'string', enum: ['patient', 'visit', 'visit_detail'], description: SCOPE_DESCRIPTION },
        tables: {
          type: 'array', items: { type: 'string' },
          description: 'The tables copied, named as plan_cohort_derivation lists them. Default: every table it can copy.',
        },
        variables: {
          type: 'string', enum: ['all', 'criteria', 'concepts'],
          description: 'The events kept: all (default), criteria (the concepts the cohort\'s criteria name), or concepts (concept_ids).',
        },
        concept_ids: { type: 'array', items: { type: 'integer' }, description: 'variables concepts: the concept ids kept.' },
        birth_precision: { type: 'string', enum: ['year', 'month', 'day'], description: 'Precision the birth dates keep. Default month.' },
        pseudonymize: { type: 'boolean', description: 'Replace the patient, visit and unit-stay ids by pseudonyms. Default true.' },
        method: {
          type: 'string', enum: ['hmac', 'random'],
          description: 'hmac (default): a keyed hash, the same pseudonyms on a rebuild while the key is kept. random: drawn anew each build.',
        },
        keep_key: {
          type: 'boolean',
          description: 'hmac: keep the key sealed in Linkr, so a rebuild or another derivation draws the same pseudonyms. Default true.',
        },
        reuse_key_of: {
          type: 'string',
          description: 'hmac: draw with the key of another derivation of this workspace (its id, from list_database_cohorts).',
        },
        correspondence_database_id: {
          type: 'string',
          description: 'Write the table of original id → pseudonym into this writable database (never the one derived into). '
            + 'Default: none — without it, a random or unkept key cannot be traced back.',
        },
        correspondence_schema: { type: 'string', description: 'Default pseudonyms.' },
        correspondence_table: { type: 'string', description: 'Default linkr_pseudonyms.' },
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
    const reason = derivableReason(cohort, source)
    if (reason) return failure(`This cohort cannot be derived: ${NOT_DERIVABLE[reason]}.`)
    const choices: DeriveOptionsInput = {
      scope: args.scope, tables: args.tables, copyPersonless: args.copy_personless,
      variables: args.variables === 'concepts' ? args.concept_ids ?? [] : args.variables,
      birthPrecision: args.birth_precision, pseudonymize: args.pseudonymize, method: args.method, keepKey: args.keep_key,
      reuseKeyOf: args.reuse_key_of,
      ...(args.correspondence_database_id ? {
        correspondence: {
          databaseId: args.correspondence_database_id, schemaName: args.correspondence_schema, tableName: args.correspondence_table,
        },
      } : {}),
    }
    const kept = derivationOptions(cohort, await api.derivePlan(source.id, cohort.level, choices.scope), choices)
    if ('error' in kept) return failure(kept.error)
    const plan = planDerivation({
      cohort,
      source,
      siblings,
      databases: databases as unknown as WebDataSource[],
      target,
      copyPersonless: kept.copyPersonless,
      options: kept.options,
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
      `Keeps ${kept.options.scope}-level individuals, ${kept.options.tables?.length} table(s), `
        + `${kept.options.variables ? `${kept.options.variables.conceptIds.length} concept(s)` : 'every variable'}, `
        + `birth dates to the ${kept.options.birthPrecision ?? 'day'}; `
        + (kept.options.pseudonymization
          ? `ids pseudonymised (${kept.options.pseudonymization.method}${kept.options.pseudonymization.keepKey ? ', key kept' : ''}`
            + `${kept.options.pseudonymization.correspondence ? ', correspondence table written' : ''}).`
          : 'ids kept as they are.'),
      `job_id: ${job.id} (${job.status})`,
      'The copy runs on the server and can take several minutes. Call get_job_status with this job_id to follow it; '
        + 'when done it gives the database id to query. The user sees it in Linkr\'s jobs panel and notifications.',
      ...(into.kind === 'schema' && !into.registerName ? ['The schema is read through the target database (e.g. run_sql on it, qualified by the schema).'] : []),
    ].join('\n'))
  }))

  server.registerTool('get_job_status', {
    description:
      'Status of a server job (a derivation, a scores computation, an index build…): queued / running / '
      + 'done / error / cancelled, progress, last log lines, and for a finished derivation the database id and counts. '
      + `To wait for a job, pass wait_seconds (up to ${MAX_JOB_WAIT_SECONDS}): the call returns as soon as it ends.`,
    annotations: READ,
    inputSchema: fromJsonSchema<{ job_id: string; wait_seconds?: number }>({
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: {
          type: 'number',
          description: `Wait up to this long for the job to end before answering (max ${MAX_JOB_WAIT_SECONDS}). Default 0.`,
        },
      },
      required: ['job_id'],
    }),
  }, guard(async ({ job_id, wait_seconds = 0 }) => text(formatJob(await waitForJob(() => api.getJob(job_id), wait_seconds)))))

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
