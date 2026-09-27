/** Projects, databases (schema, concepts, SQL) and cohorts. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import {
  buildAttritionQueries, buildCohortCountSql, buildCohortCriteriaSql, buildCohortNativeSql, buildCohortResultsSql,
} from '@/lib/duckdb/cohort-query'
import {
  buildConceptsQuery, computeAvailableColumns,
} from '@/features/projects/warehouse/concepts/concept-queries'
import { conceptRelations, dictionaryOf, eventRelation } from '@/lib/schema-classes/relations'
import { buildCohortReportModel, CohortReportUnavailable } from '@/lib/cohort-report/model'
import { renderReportHtml } from '@/lib/cohort-report/render-html'
import { DEFAULT_SUPPRESSION_THRESHOLD } from '@/lib/cohort-report/suppress'
import type { AttritionStep, Cohort, CohortLevel, SchemaMapping } from '@/types'
import {
  COHORT_LEVELS, CRITERIA_FORMAT, applyConceptNames, conceptIdsByTable, customSqlIdHint,
  formatRows, normalizeCriteria, renderTree,
} from './cohorts.js'
import { REPORT_LANGUAGES, embedReportHtml, reportTranslator, summarizeReport, type ReportLanguage } from './report.js'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, mappingOf, projectDatabases, text, type Server,
  type ToolResult,
} from './shared.js'
import { ApiError } from './api.js'

/** Runs a cohort's queries; a hand-written query that returns no id column for
 *  its level fails with what to change, not with DuckDB's COLUMNS error. */
async function withCohortErrors(cohort: Cohort, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run()
  } catch (e) {
    const hint = customSqlIdHint(cohort, e instanceof ApiError ? e.message : (e as Error).message)
    if (hint) return failure(hint)
    throw e
  }
}

/** The database a cohort runs on — the one owning it, its own, else the project's
 *  first usable one (as the app does). */
export async function cohortDatabase(cohort: Cohort): Promise<string> {
  const own = cohort.ownerDataSourceId ?? cohort.dataSourceId
  if (own) return own
  if (!cohort.projectUid) throw new Error('This cohort has neither a project nor a database.')
  const dbs = await projectDatabases(cohort.projectUid)
  const usable = dbs.find((d) => d.status === 'connected' && d.schemaMapping?.patient)
  if (!usable) throw new Error('This cohort has no database and its project has no usable linked database.')
  return usable.id
}

/** Look up concept names for every concept criterion, one query per dictionary. */
async function fillConceptNames(databaseId: string, mapping: SchemaMapping, tree: Cohort['criteriaTree']) {
  const names = new Map<string, Map<number, string>>()
  for (const [label, ids] of conceptIdsByTable(tree)) {
    const event = eventRelation(mapping, label)
    const dict = event ? dictionaryOf(mapping, event) : undefined
    if (!dict) continue
    const rows = await api.query(databaseId,
      `SELECT concept_id AS id, concept_name AS name FROM ${dict.name} WHERE concept_id IN (${[...ids].join(', ')})`)
    names.set(label, new Map(rows.map((r) => [Number(r.id), String(r.name)])))
  }
  applyConceptNames(tree, names)
}

export function describeCohort(c: Cohort, mapping?: SchemaMapping): string {
  const lines = [
    `Cohort "${loc(c.name)}" (id ${c.id})`,
    c.ownerDataSourceId
      ? `Database cohort (owner ${c.ownerDataSourceId}) · level: ${c.level}`
      : `Project: ${c.projectUid} · level: ${c.level} · database: ${c.dataSourceId ?? '(project default)'}`,
  ]
  if (loc(c.description)) lines.push(`Description: ${loc(c.description)}`)
  if (c.resultCount != null) lines.push(`Last count: ${c.resultCount}`)
  lines.push('', 'Criteria:', mapping ? renderTree(c.criteriaTree, mapping) : JSON.stringify(c.criteriaTree))
  if (c.customSql) lines.push('', 'Custom SQL (overrides the criteria):', c.customSql)
  return lines.join('\n')
}

export function registerWarehouseTools(server: Server): void {
  // ---------------------------------------------------------------------------
  // Exploration
  // ---------------------------------------------------------------------------

  server.registerTool('describe_database', {
    description:
      'List the tables of a database with their columns and types. Without `table`, gives every table '
      + 'with its column names; with `table`, the full column list of that table. Use it to write SQL.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ database_id: string; table?: string }>({
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        table: { type: 'string', description: 'A table name (as listed), to see its columns in detail.' },
      },
      required: ['database_id'],
    }),
  }, guard(async ({ database_id, table }) => {
    const tables = await api.getSchema(database_id)
    if (table) {
      const t = tables.find((x) => x.name === table)
        ?? tables.find((x) => x.name.toLowerCase().endsWith(table.toLowerCase()))
      if (!t) return failure(`No table "${table}". Tables: ${tables.map((x) => x.name).join(', ')}`)
      return text(`${t.name}\n${t.columns.map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join('\n')}`)
    }
    return text(tables.map((t) => `${t.name}: ${t.columns.map((c) => c.name).join(', ')}`).join('\n'))
  }))

  server.registerTool('search_concepts', {
    description:
      'Search the database\'s concept dictionaries (e.g. lab items, chart items, diagnoses) by name, code '
      + 'or id — fuzzy, typo-tolerant. Returns concept ids with how many records and patients use them, '
      + 'which is how you pick the conceptIds of a concept criterion. Prefer concepts with many patients.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ database_id: string; query: string; dictionary?: string; limit?: number }>({
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        query: { type: 'string', description: 'Words to search, e.g. "lactate" or "heart rate".' },
        dictionary: { type: 'string', description: 'Restrict to one dictionary key (see get_project_context).' },
        limit: { type: 'number', description: 'Max results, default 20.' },
      },
      required: ['database_id', 'query'],
    }),
  }, guard(async ({ database_id, query, dictionary, limit }) => {
    const mapping = await mappingOf(database_id)
    const dicts = conceptRelations(mapping)
    if (dicts.length === 0) return failure('This database has no concept dictionary in its mapping.')
    const columns = computeAvailableColumns(dicts)
    const filters = { _searchFuzzy: query, ...(dictionary ? { _dict_key: [dictionary] } : {}) }
    const sql = buildConceptsQuery(mapping, filters, columns, 0, Math.min(limit ?? 20, 100),
      { columnId: 'patient_count', desc: true })
    if (!sql) return failure('Could not build a concept search for this mapping.')
    const rows = await api.query(database_id, sql)
    const keep = ['concept_id', 'concept_name', 'concept_code', 'vocabulary_id', 'domain_id', 'concept_class_id',
      'standard_concept', '_dict_key',
      'record_count', 'patient_count']
    return text(formatRows(rows.map((r) =>
      Object.fromEntries(keep.filter((k) => k in r).map((k) => [k === '_dict_key' ? 'dictionary' : k, r[k]]))), 100))
  }))

  server.registerTool('run_sql', {
    description:
      'Run a read-only SQL query (DuckDB dialect) on a database and get the rows back. Use it to check '
      + 'values, units, distributions or to prototype a custom cohort query. Writes are refused. Table names '
      + 'may need their schema prefix (e.g. hosp.patients) — see describe_database.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ database_id: string; sql: string; max_rows?: number }>({
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        sql: { type: 'string' },
        max_rows: { type: 'number', description: 'Rows shown, default 50, max 500. Aggregate rather than list.' },
      },
      required: ['database_id', 'sql'],
    }),
  }, guard(async ({ database_id, sql, max_rows }) => {
    const rows = await api.query(database_id, sql)
    return text(formatRows(rows, Math.min(max_rows ?? 50, 500)))
  }))

  // ---------------------------------------------------------------------------
  // Cohorts
  // ---------------------------------------------------------------------------

  server.registerTool('list_cohorts', {
    description: 'List a project\'s cohorts with their level and last count.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const cohorts = await api.listCohorts(project_uid)
    if (cohorts.length === 0) return text('No cohort in this project.')
    return text(cohorts.map((c) => `- "${loc(c.name)}" — cohort_id: ${c.id} · level ${c.level}`
      + `${c.resultCount != null ? ` · last count ${c.resultCount}` : ''}`).join('\n'))
  }))

  server.registerTool('get_cohort', {
    description: 'A cohort\'s definition: level, database, criteria tree (readable and as JSON), custom SQL.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ cohort_id: string }>({
      type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id }) => {
    const cohort = await api.getCohort(cohort_id)
    const mapping = await mappingOf(await cohortDatabase(cohort)).catch(() => undefined)
    return text(`${describeCohort(cohort, mapping)}\n\nCriteria JSON:\n${JSON.stringify(cohort.criteriaTree)}`)
  }))

  const COHORT_FIELDS = {
    name: { type: 'string' },
    description: { type: 'string' },
    level: {
      type: 'string', enum: COHORT_LEVELS,
      description: 'What one row of the cohort is: patient, visit (hospital stay), visit_detail (unit stay, e.g. an ICU stay) or event.',
    },
    database_id: { type: 'string', description: 'Which linked database it runs on. Default: the project\'s first usable one.' },
    criteria: { description: CRITERIA_FORMAT },
  } as const

  /** Validate criteria against the cohort's database, fill concept names, report warnings. */
  async function prepareCriteria(criteria: unknown, databaseId: string) {
    const mapping = await mappingOf(databaseId)
    const result = normalizeCriteria(criteria, mapping)
    if (result.errors.length === 0) await fillConceptNames(databaseId, mapping, result.tree)
    return { ...result, mapping }
  }

  server.registerTool('create_cohort', {
    description:
      'Create a cohort in a project: a patient/stay selection defined by criteria, which the app compiles to '
      + 'SQL. Criteria are optional here (set them later with update_cohort). Nothing is run: call run_cohort '
      + 'next to get the count and attrition.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; name: string; description?: string; level: CohortLevel; database_id?: string; criteria?: unknown
    }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, ...COHORT_FIELDS },
      required: ['project_uid', 'name', 'level'],
    }),
  }, guard(async ({ project_uid, name, description, level, database_id, criteria }) => {
    const dbs = await projectDatabases(project_uid)
    const db = database_id
      ? dbs.find((d) => d.id === database_id)
      : dbs.find((d) => d.status === 'connected' && d.schemaMapping?.patient)
    if (!db) return failure(database_id ? `Database ${database_id} is not linked to this project.` : 'No usable database in this project.')
    const prepared = await prepareCriteria(criteria ?? [], db.id)
    if (prepared.errors.length) return failure(`Not created — fix the criteria:\n- ${prepared.errors.join('\n- ')}`)
    const pointer = db.lineageId || db.entityId
      ? { ...(db.lineageId ? { lineageId: db.lineageId } : {}), ...(db.entityId ? { entityId: db.entityId } : {}), label: db.name }
      : undefined
    const cohort = await api.createCohort({
      id: randomUUID(),
      projectUid: project_uid,
      name: { en: name },
      description: { en: description ?? '' },
      dataSourceId: db.id,
      ...(pointer ? { dataSourceRef: pointer } : {}),
      level,
      criteriaTree: prepared.tree,
      schemaVersion: 5,
    })
    const warn = prepared.warnings.length ? `\n\nWarnings:\n- ${prepared.warnings.join('\n- ')}` : ''
    return text(`Created.\n\n${describeCohort(cohort, prepared.mapping)}${warn}`)
  }))

  server.registerTool('update_cohort', {
    description:
      'Change a cohort: any of name, description, level, database, criteria (REPLACES the whole tree — '
      + 'read it with get_cohort first to keep existing criteria), or custom_sql. custom_sql, when set, '
      + 'replaces the criteria entirely: it is the MEMBERSHIP query, one row per member. It may read the Linkr '
      + 'relations (linkr_visit…) or the database\'s own tables, and must return the level\'s id column under '
      + 'its Linkr name — patient_id, visit_id or visit_detail_id (e.g. SELECT stay_id AS visit_detail_id FROM '
      + 'icustays …); other columns are ignored. Count, results, freeze, derivation, report and Patient data all '
      + 'follow it; attrition has a single step. '
      + 'Start from preview_cohort_sql. Pass null to go back to the criteria.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      cohort_id: string; name?: string; description?: string; level?: CohortLevel; database_id?: string
      criteria?: unknown; custom_sql?: string | null
    }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        ...COHORT_FIELDS,
        custom_sql: { type: ['string', 'null'], description: 'SELECT <level id column> FROM … WHERE …, or null.' },
      },
      required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id, name, description, level, database_id, criteria, custom_sql }) => {
    const cohort = await api.getCohort(cohort_id)
    const changes: Record<string, unknown> = {}
    const warnings: string[] = []
    if (name !== undefined) changes.name = { ...(typeof cohort.name === 'object' ? cohort.name : {}), en: name }
    if (description !== undefined) {
      changes.description = { ...(typeof cohort.description === 'object' ? cohort.description : {}), en: description }
    }
    if (level !== undefined) changes.level = level
    if (database_id !== undefined) {
      if (!cohort.projectUid) return failure('This cohort belongs to a database: it always runs on that database.')
      const dbs = await projectDatabases(cohort.projectUid)
      if (!dbs.some((d) => d.id === database_id)) return failure(`Database ${database_id} is not linked to this project.`)
      changes.dataSourceId = database_id
    }
    const dbId = database_id ?? await cohortDatabase(cohort)
    let mapping: SchemaMapping | undefined
    if (criteria !== undefined) {
      const prepared = await prepareCriteria(criteria, dbId)
      if (prepared.errors.length) return failure(`Not updated — fix the criteria:\n- ${prepared.errors.join('\n- ')}`)
      changes.criteriaTree = prepared.tree
      warnings.push(...prepared.warnings)
      mapping = prepared.mapping
    }
    if (custom_sql !== undefined) changes.customSql = custom_sql
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    // A stale count would read as the new definition's until the next run.
    changes.resultCount = null
    changes.attrition = null
    const updated = await api.updateCohort(cohort_id, changes)
    if (updated.customSql && criteria !== undefined) warnings.push('This cohort has custom SQL: the criteria are ignored until custom_sql is set to null.')
    const warn = warnings.length ? `\n\nWarnings:\n- ${warnings.join('\n- ')}` : ''
    return text(`Updated.\n\n${describeCohort(updated, mapping ?? await mappingOf(dbId).catch(() => undefined))}${warn}`)
  }))

  server.registerTool('delete_cohort', {
    description: 'Delete a cohort. Ask the user first; they can undo it from Linkr\'s notifications.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ cohort_id: string }>({
      type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id }) => {
    const cohort = await api.getCohort(cohort_id)
    await api.deleteCohort(cohort_id)
    return text(`Deleted cohort "${loc(cohort.name)}".`)
  }))

  server.registerTool('preview_cohort_sql', {
    description:
      'Show the membership query the app generates from a cohort\'s criteria (the level\'s id), on the Linkr '
      + 'relations and on the database\'s own tables, without running it (what the app\'s SQL tab shows). Useful '
      + 'to check the logic or as a starting point for custom_sql.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ cohort_id: string }>({
      type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id }) => {
    const cohort = await api.getCohort(cohort_id)
    const mapping = await mappingOf(await cohortDatabase(cohort))
    const generated = buildCohortCriteriaSql(cohort, mapping)
    const native = buildCohortNativeSql(cohort, mapping)
    if (cohort.customSql) {
      return text(`This cohort uses custom SQL (in effect):\n${cohort.customSql}\n\nFrom its criteria (not in effect):\n${generated ?? '(none)'}`)
    }
    if (!generated) return failure('The criteria produce no runnable query (empty level table in the mapping?).')
    return text(`Membership query, on the Linkr relations (portable):\n${generated}`
      + (native ? `\n\nThe same, on this database's own tables:\n${native}` : ''))
  }))

  server.registerTool('run_cohort', {
    description:
      'Run a cohort on its database: total count, attrition (how many remain after each top-level '
      + 'criterion, in order) and, on request, sample rows. Saves the count on the cohort, as the app\'s Run button '
      + 'does. Check the attrition: a step that removes nobody, or everybody, usually means a wrong criterion.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: fromJsonSchema<{ cohort_id: string; sample_rows?: number }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        sample_rows: {
          type: 'number',
          description: 'Patient-level rows to show, default 0, max 50. Counts and attrition are usually enough.',
        },
      },
      required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id, sample_rows }) => {
    const cohort = await api.getCohort(cohort_id)
    return withCohortErrors(cohort, () => runCohort(cohort, sample_rows))
  }))

  server.registerTool('cohort_report', {
    title: 'Cohort report',
    description:
      'The cohort\'s full report, as the app\'s Report button builds it: counts, inclusion flowchart, criteria, '
      + 'concepts, age / sex / index-date charts, care units, methodology. Runs the cohort fresh (about 30 queries). '
      + 'Returns a text summary for you and the report itself as a UI resource that the chat renders inline: '
      + 'place its marker in your answer where the report should appear, with a short introduction — do not '
      + 'retype the report. Small counts are suppressed (<threshold). With custom SQL, the flowchart has one step for '
      + 'it and no criteria are listed.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ cohort_id: string; language?: ReportLanguage; include_sql?: boolean; threshold?: number }>({
      type: 'object',
      properties: {
        cohort_id: { type: 'string' },
        language: { type: 'string', enum: [...REPORT_LANGUAGES], description: 'The user\'s language, default en.' },
        include_sql: { type: 'boolean', description: 'Append the membership SQL under Methodology, default false.' },
        threshold: {
          type: 'number',
          description: `Small-cell suppression threshold, default ${DEFAULT_SUPPRESSION_THRESHOLD}: counts 1 to threshold-1 are hidden.`,
        },
      },
      required: ['cohort_id'],
    }),
  }, guard(async ({ cohort_id, language = 'en', include_sql = false, threshold = DEFAULT_SUPPRESSION_THRESHOLD }) => {
    const cohort = await api.getCohort(cohort_id)
    const dbId = await cohortDatabase(cohort)
    const db = await api.getDataSource(dbId)
    if (!db.schemaMapping) return failure(`Database ${dbId} has no schema mapping; no report is possible.`)
    const t = await reportTranslator(language)
    const pick = (v: Record<string, string> | string | null | undefined) =>
      v == null ? '' : typeof v === 'string' ? v : v[language] ?? loc(v)
    let model
    try {
      model = await buildCohortReportModel({
        cohort,
        mapping: db.schemaMapping,
        databaseName: pick(db.name),
        databaseVersion: db.version ?? undefined,
        schemaLabel: pick(db.schemaSource?.label) || pick(db.schemaMapping.presetLabel) || undefined,
        run: (sql) => api.query(dbId, sql),
        t,
        locale: language,
        threshold: Math.min(Math.max(Math.round(threshold), 1), 1000),
      })
    } catch (e) {
      if (e instanceof CohortReportUnavailable) return failure(t(`cohort_report.unavailable_${e.reason}`))
      return withCohortErrors(cohort, () => { throw e })
    }
    const html = embedReportHtml(renderReportHtml(model, t, { includeSql: include_sql }))
    return {
      content: [
        {
          type: 'text',
          text: 'The full report is attached below as a UI resource. Show it to the user by writing its marker '
            + '(\\ui{…}, given after the resource) in your answer, after one introductory sentence; do not retype '
            + `the report.\n\n${summarizeReport(model)}`,
        },
        { type: 'resource', resource: { uri: `ui://linkr/cohort-report/${cohort.id}`, mimeType: 'text/html', text: html } },
      ],
    }
  }))
}

/** run_cohort's work: count, attrition, a sample, the count saved. */
async function runCohort(cohort: Cohort, sampleRows: number | undefined): Promise<ToolResult> {
  const dbId = await cohortDatabase(cohort)
  const mapping = await mappingOf(dbId)
  const countSql = buildCohortCountSql(cohort, mapping)
  if (!countSql) return failure('The criteria produce no runnable query.')
  const started = Date.now()
  const total = Number((await api.query(dbId, countSql))[0]?.cnt ?? NaN)
  if (Number.isNaN(total)) return failure('The count query returned no "cnt" column.')

  const attrition: AttritionStep[] = []
  let prev = 0
  for (const step of buildAttritionQueries(cohort, mapping)) {
    const count = Number((await api.query(dbId, step.sql))[0]?.cnt ?? 0)
    attrition.push({ nodeId: step.nodeId, label: step.label, count, excluded: step.nodeId === '__total__' ? 0 : prev - count })
    prev = count
  }
  // Rows are patient-level data; aggregates are the default (plan §2: with a
  // remote model, schema and aggregates only).
  const n = Math.min(sampleRows ?? 0, 50)
  const sampleSql = n > 0 ? buildCohortResultsSql(cohort, mapping, n, 0) : null
  const sample = sampleSql ? await api.query(dbId, sampleSql) : []
  await api.updateCohort(cohort.id, { resultCount: total, attrition })

  const out = [`"${loc(cohort.name)}": ${total} ${cohort.level}(s) — ${Date.now() - started} ms`]
  if (attrition.length) {
    out.push('', 'Attrition:')
    for (const a of attrition) {
      out.push(`  ${a.nodeId === '__total__' ? 'All' : a.label}: ${a.count}${a.excluded ? `  (−${a.excluded})` : ''}`)
    }
  }
  if (sample.length) out.push('', 'Sample:', formatRows(sample, n))
  return text(out.join('\n'))
}
