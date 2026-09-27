/** Data quality: rule sets, their custom checks, scans and run history. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { errorResult, evaluateCheck, type DqCategory, type DqCheck, type DqCheckResult, type DqCheckSource, type DqReport } from '@/lib/duckdb/data-quality-checks'
import { injectClassRelations } from '@/lib/schema-classes/inject'
import { RELATION_PREFIX } from '@/lib/schema-classes/contracts'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'
import { userToAuthorDetails } from '@/lib/user-identity'
import type { DqCustomCheck, DqRuleSet, DqRunHistoryEntry, SchemaMapping, User } from '@/types'
import type { DataSource } from './api.js'
import {
  CATEGORIES, CHECK_KINDS, SEVERITIES, SOURCES, buildChecks, checkTestProblem, formatCheckList, formatReport,
  isFiltered, makeReport, runEntry, selectChecks, validateCheckFields, type CheckFields,
} from './dq.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, text, type Server } from './shared.js'

const SET = '/dq-rule-sets'
const enc = encodeURIComponent

const dq = {
  listRuleSets: (workspaceId?: string) =>
    api.request<DqRuleSet[]>('GET', `${SET}${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  getRuleSet: (id: string) => api.request<DqRuleSet>('GET', `${SET}/${enc(id)}`),
  createRuleSet: (body: Record<string, unknown>) => api.request<DqRuleSet>('POST', SET, body),
  updateRuleSet: (id: string, changes: Record<string, unknown>) =>
    api.request<DqRuleSet>('PATCH', `${SET}/${enc(id)}`, changes),
  deleteRuleSet: (id: string) => api.request<void>('DELETE', `${SET}/${enc(id)}`),
  listChecks: (ruleSetId: string) => api.request<DqCustomCheck[]>('GET', `${SET}/${enc(ruleSetId)}/checks`),
  deleteAllChecks: (ruleSetId: string) => api.request<void>('DELETE', `${SET}/${enc(ruleSetId)}/checks`),
  createCheck: (body: Record<string, unknown>) => api.request<DqCustomCheck>('POST', '/dq-custom-checks', body),
  updateCheck: (id: string, changes: Record<string, unknown>) =>
    api.request<DqCustomCheck>('PATCH', `/dq-custom-checks/${enc(id)}`, changes),
  deleteCheck: (id: string) => api.request<void>('DELETE', `/dq-custom-checks/${enc(id)}`),
  listRuns: (ruleSetId: string) => api.request<DqRunHistoryEntry[]>('GET', `${SET}/${enc(ruleSetId)}/runs`),
  createRun: (body: Record<string, unknown>) => api.request<DqRunHistoryEntry>('POST', '/dq-run-history', body),
  deleteRun: (id: string) => api.request<void>('DELETE', `/dq-run-history/${enc(id)}`),
  deleteAllRuns: (ruleSetId: string) => api.request<void>('DELETE', `${SET}/${enc(ruleSetId)}/runs`),
}

const RULE_SET_NOTE = 'A data-quality rule set is a workspace-level set of checks run against one clinical '
  + 'database: the checks Linkr generates from the database (built-in: empty tables, NULL rates; schema: '
  + 'mapping-aware consistency and plausibility) plus the rule set\'s own custom SQL checks.'

async function ruleSetOrFail(id: string): Promise<DqRuleSet> {
  try {
    return await dq.getRuleSet(id)
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error(`No rule set ${id}. list_dq_rule_sets lists them.`)
    throw e
  }
}

async function workspaceOf(args: { workspace_id?: string; project_uid?: string }): Promise<string | undefined> {
  if (args.workspace_id) return args.workspace_id
  if (!args.project_uid) return undefined
  const project = await api.getProject(args.project_uid)
  if (!project.workspaceId) throw new Error(`Project ${args.project_uid} belongs to no workspace.`)
  return project.workspaceId
}

/** The database a rule set may target: it exists and lives in the rule set's workspace. */
async function databaseFor(workspaceId: string, databaseId: string): Promise<DataSource> {
  const ds = await api.getDataSource(databaseId)
  if (ds.workspaceId && ds.workspaceId !== workspaceId) {
    throw new Error(`Database ${databaseId} belongs to another workspace than the rule set.`)
  }
  return ds
}

const pointerOf = (ds: DataSource) => (ds.lineageId || ds.entityId
  ? { ...(ds.lineageId ? { lineageId: ds.lineageId } : {}), ...(ds.entityId ? { entityId: ds.entityId } : {}), label: ds.name }
  : undefined)

/** The server runs SQL as sent: `linkr_*` relations are resolved here, once per scan. */
async function runSql(databaseId: string, mapping: SchemaMapping | null | undefined, sql: string) {
  const resolved = sql.toLowerCase().includes(RELATION_PREFIX) ? injectClassRelations(sql, mapping) : sql
  return (await api.request<{ rows: Record<string, unknown>[] }>(
    'POST', `/data-sources/${enc(databaseId)}/query`, { sql: resolved },
  )).rows
}

async function runChecks(databaseId: string, mapping: SchemaMapping | null | undefined, checks: DqCheck[]) {
  const results: DqCheckResult[] = new Array(checks.length)
  let next = 0
  const worker = async () => {
    while (next < checks.length) {
      const i = next++
      const start = performance.now()
      try {
        const rows = await runSql(databaseId, mapping, checks[i].sql)
        results[i] = evaluateCheck(checks[i], rows, Math.round(performance.now() - start))
      } catch (e) {
        results[i] = errorResult(checks[i], e, Math.round(performance.now() - start))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, checks.length) }, worker))
  return results
}

async function allChecks(rs: DqRuleSet) {
  if (!rs.dataSourceId) {
    throw new Error('This rule set has no database yet: set one with update_dq_rule_set (database_id).')
  }
  const ds = await api.getDataSource(rs.dataSourceId)
  if (ds.status && ds.status !== 'connected') throw new Error(`Database ${ds.id} is ${ds.status}: it cannot be queried.`)
  const [tables, custom] = await Promise.all([api.getSchema(ds.id), dq.listChecks(rs.id)])
  return { ds, checks: buildChecks(tables, ds.schemaMapping, custom), custom }
}

function describeRuleSet(rs: DqRuleSet): string {
  const lines = [
    `Rule set "${loc(rs.name)}" — rule_set_id: ${rs.id}${rs.entityId ? ` · entity id ${rs.entityId}` : ''}`,
    `Workspace ${rs.workspaceId} · database ${rs.dataSourceId || '(none)'} · status ${rs.status} · version ${rs.version ?? '0.1.0'}`,
  ]
  if (loc(rs.description)) lines.push(`Description: ${loc(rs.description).slice(0, 800)}`)
  if (rs.lastRunAt) lines.push(`Last run ${rs.lastRunAt}: score ${rs.lastScore ?? '?'}%${rs.lastRunDurationMs != null ? ` in ${rs.lastRunDurationMs} ms` : ''}`)
  return lines.join('\n')
}

function describeCustomCheck(c: DqCustomCheck): string {
  return `- ${c.name} — check_id: ${c.id} [${c.category} · ${c.severity} · threshold ${c.threshold}%]`
    + `${c.description ? `\n  ${c.description}` : ''}\n  SQL: ${c.sql.replace(/\s+/g, ' ').trim().slice(0, 1500)}`
}

async function testCheckSql(rs: DqRuleSet, sql: string): Promise<string | null> {
  if (!rs.dataSourceId) return null
  const ds = await api.getDataSource(rs.dataSourceId)
  try {
    return checkTestProblem(await runSql(ds.id, ds.schemaMapping, sql))
  } catch (e) {
    return `The SQL failed on database ${ds.id}: ${(e as Error).message}`
  }
}

const CHECK_FIELDS = {
  name: { type: 'string', description: 'Short name shown in the check list.' },
  description: { type: 'string', description: 'What the check verifies (shown in results).' },
  category: { type: 'string', enum: CATEGORIES },
  severity: { type: 'string', enum: SEVERITIES },
  threshold: {
    type: 'number', minimum: 0, maximum: 100,
    description: 'Max % of violated rows allowed before the check fails; 0 (default) = any violated row fails.',
  },
  sql: {
    type: 'string',
    description: 'A query on the rule set\'s database returning ONE row with violated_rows and total_rows (bigint), '
      + 'e.g. SELECT COUNT(*) FILTER (WHERE value_as_number < 0)::BIGINT AS violated_rows, COUNT(*)::BIGINT AS '
      + 'total_rows FROM measurement. Table names as describe_database lists them; the class relations '
      + '(linkr_patient, linkr_visit, linkr_event_<key>…) work too.',
  },
  skip_test: {
    type: 'boolean',
    description: 'Save without test-running the SQL on the database (default false: a failing SQL is refused).',
  },
} as const

const FILTER_FIELDS = {
  check_ids: { type: 'array', items: { type: 'string' }, description: 'Only these checks (ids from list_dq_checks).' },
  sources: { type: 'array', items: { type: 'string', enum: SOURCES }, description: 'Only checks of these origins.' },
  categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
  tables: { type: 'array', items: { type: 'string' }, description: 'Only checks on these tables.' },
} as const

type Filter = { check_ids?: string[]; sources?: DqCheckSource[]; categories?: DqCategory[]; tables?: string[] }
const toFilter = (f: Filter, rs: DqRuleSet) => ({
  checkIds: f.check_ids, sources: f.sources, categories: f.categories, tables: f.tables,
  disabledIds: rs.disabledCheckIds,
})

export function registerDqTools(server: Server): void {
  // ---------------------------------------------------------------------------
  // Rule sets
  // ---------------------------------------------------------------------------

  server.registerTool('list_dq_rule_sets', {
    description: `List data-quality rule sets. ${RULE_SET_NOTE} Filter by workspace (workspace_id, or `
      + 'project_uid for its workspace); without either, every rule set you can read.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string }>({
      type: 'object',
      properties: { workspace_id: { type: 'string' }, project_uid: { type: 'string' } },
    }),
  }, guard(async (args) => {
    const sets = await dq.listRuleSets(await workspaceOf(args))
    if (!sets.length) return text('No data-quality rule set. create_dq_rule_set makes one.')
    return text(sets.map((rs) =>
      `- "${loc(rs.name)}" — rule_set_id: ${rs.id} · database ${rs.dataSourceId || '(none)'} · ${rs.status}`
      + `${rs.lastScore != null ? ` · last score ${rs.lastScore}% (${rs.lastRunAt})` : ''}`,
    ).join('\n'))
  }))

  server.registerTool('get_dq_rule_set', {
    description: 'A data-quality rule set: its database, last score, its custom SQL checks (with their SQL) and '
      + 'its recent runs. The generated checks are listed by list_dq_checks.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string }>({
      type: 'object', properties: { rule_set_id: { type: 'string' } }, required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const [checks, runs] = await Promise.all([dq.listChecks(rs.id), dq.listRuns(rs.id)])
    const out = [describeRuleSet(rs), '', `Custom checks (${checks.length}):`]
    const sorted = [...checks].sort((a, b) => a.order - b.order)
    out.push(...sorted.slice(0, 40).map(describeCustomCheck))
    if (sorted.length > 40) out.push(`… ${sorted.length - 40} more (list_dq_checks with sources ["custom"]).`)
    if (rs.disabledCheckIds?.length) out.push('', `Disabled checks: ${rs.disabledCheckIds.join(', ')}`)
    out.push('', `Runs (${runs.length}):`)
    out.push(...runs.slice(0, 10).map((r) =>
      `- run_id ${r.id} · ${r.startedAt} · ${r.status} · score ${r.score ?? '?'}% · ${r.passed}/${r.totalChecks} passed, `
      + `${r.failed} failed, ${r.errors} error(s)`))
    if (runs.length > 10) out.push(`… ${runs.length - 10} older (list_dq_runs).`)
    return text(out.join('\n'))
  }))

  server.registerTool('create_dq_rule_set', {
    description: `Create a data-quality rule set. ${RULE_SET_NOTE} It lives in a workspace (workspace_id, or `
      + 'project_uid for its workspace) and targets one database of that workspace (database_id, e.g. from '
      + 'get_project_context). Then add custom checks (create_dq_check) and run it (run_dq_rule_set).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      name: string; description?: string; database_id: string; workspace_id?: string; project_uid?: string
      entity_id?: string; version?: string
    }>({
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        database_id: { type: 'string' },
        workspace_id: { type: 'string' },
        project_uid: { type: 'string', description: 'Alternative to workspace_id: the workspace of this project.' },
        entity_id: {
          type: 'string',
          description: 'Readable identifier (lowercase, digits, hyphens; unique in the workspace). Default: from the name.',
        },
        version: { type: 'string', description: 'Semver, default 0.1.0.' },
      },
      required: ['name', 'database_id'],
    }),
  }, guard(async (args) => {
    const name = args.name.trim()
    if (!name) return failure('name must not be empty.')
    const workspaceId = await workspaceOf(args)
    if (!workspaceId) return failure('Give workspace_id or project_uid: a rule set lives in a workspace.')
    const ds = await databaseFor(workspaceId, args.database_id)
    const taken = (await dq.listRuleSets(workspaceId)).map((r) => r.entityId).filter((x): x is string => !!x)
    let entityId: string
    if (args.entity_id) {
      if (args.entity_id.length < 2 || slugifyId(args.entity_id) !== args.entity_id) {
        return failure('entity_id: 2–50 characters, lowercase letters, digits and inner hyphens only.')
      }
      if (taken.includes(args.entity_id)) return failure(`entity_id "${args.entity_id}" is already used in this workspace.`)
      entityId = args.entity_id
    } else {
      entityId = uniqueEntityId(slugifyId(name), taken)
    }
    const me = await api.request<Partial<User> & { id: number; username: string }>('GET', '/auth/me')
    const now = new Date().toISOString()
    const pointer = pointerOf(ds)
    const rs = await dq.createRuleSet({
      id: randomUUID(),
      entityId,
      workspaceId,
      name: { en: name },
      description: { en: args.description?.trim() ?? '' },
      dataSourceId: ds.id,
      ...(pointer ? { dataSourceRef: pointer } : {}),
      badges: [],
      status: 'draft',
      version: args.version?.trim() || '0.1.0',
      createdById: me.id,
      createdBy: `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || me.username,
      createdByDetails: userToAuthorDetails(me),
      lineageId: randomUUID(),
      createdAt: now,
    })
    return text(`Created.\n\n${describeRuleSet(rs)}`)
  }))

  server.registerTool('update_dq_rule_set', {
    description: 'Change a data-quality rule set: name, description (English text), database, version. '
      + 'Changing the database changes what the next run checks.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      rule_set_id: string; name?: string; description?: string; database_id?: string; version?: string
    }>({
      type: 'object',
      properties: {
        rule_set_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        database_id: { type: 'string' },
        version: { type: 'string' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, name, description, database_id, version }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const changes: Record<string, unknown> = {}
    if (name !== undefined) {
      if (!name.trim()) return failure('name must not be empty.')
      changes.name = { ...rs.name, en: name.trim() }
    }
    if (description !== undefined) changes.description = { ...rs.description, en: description.trim() }
    if (database_id !== undefined) {
      const ds = await databaseFor(rs.workspaceId, database_id)
      changes.dataSourceId = ds.id
      changes.dataSourceRef = pointerOf(ds) ?? null
    }
    if (version !== undefined) changes.version = version.trim() || '0.1.0'
    if (!Object.keys(changes).length) return failure('Nothing to change.')
    return text(`Updated.\n\n${describeRuleSet(await dq.updateRuleSet(rs.id, changes))}`)
  }))

  server.registerTool('delete_dq_rule_set', {
    description: 'Delete a data-quality rule set with its custom checks and run history. Cannot be undone. '
      + 'Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string }>({
      type: 'object', properties: { rule_set_id: { type: 'string' } }, required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    await dq.deleteAllChecks(rs.id)
    await dq.deleteRuleSet(rs.id)
    return text(`Deleted rule set "${loc(rs.name)}" (${rs.id}).`)
  }))

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  server.registerTool('list_dq_checks', {
    description: 'Every check a data-quality rule set runs on its database: the ones Linkr generates '
      + '(builtin: empty tables and per-column NULL rates; schema: from the schema mapping) and the rule set\'s '
      + 'custom SQL checks, with ids to pass to run_dq_rule_set. Starts with the catalogue of generated check '
      + 'kinds. Filter by source, category or table.',
    annotations: READ,
    inputSchema: fromJsonSchema<Filter & { rule_set_id: string; detail_fields?: boolean; include_sql?: boolean }>({
      type: 'object',
      properties: {
        rule_set_id: { type: 'string' },
        sources: FILTER_FIELDS.sources,
        categories: FILTER_FIELDS.categories,
        tables: FILTER_FIELDS.tables,
        detail_fields: { type: 'boolean', description: 'List every per-column NULL-rate check instead of a count per table.' },
        include_sql: { type: 'boolean', description: 'Show each check\'s SQL.' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const { checks, ds } = await allChecks(rs)
    const { checks: kept } = selectChecks(checks, { ...toFilter(args, rs), disabledIds: [] })
    const kinds = Object.entries(CHECK_KINDS).map(([k, v]) => `  ${k}: ${v}`).join('\n')
    return text([
      `Checks of "${loc(rs.name)}" on database ${ds.id} — ${kept.length} of ${checks.length}`
        + `${ds.schemaMapping ? '' : ' (no schema mapping: no schema checks)'}.`,
      `Check kinds:\n${kinds}`,
      'A check fails when violated_rows > 0 (threshold 0) or its % of violated rows exceeds the threshold.',
      '',
      formatCheckList(kept, new Set(rs.disabledCheckIds ?? []), { detailFields: args.detail_fields, withSql: args.include_sql }),
    ].join('\n'))
  }))

  server.registerTool('create_dq_check', {
    description: 'Add a custom SQL check to a data-quality rule set. The SQL runs on the rule set\'s database '
      + 'and must return one row with violated_rows and total_rows; it is test-run first and refused if it '
      + 'fails (unless skip_test).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<CheckFields & { rule_set_id: string; skip_test?: boolean }>({
      type: 'object',
      properties: { rule_set_id: { type: 'string' }, ...CHECK_FIELDS },
      required: ['rule_set_id', 'name', 'category', 'severity', 'sql'],
    }),
  }, guard(async (args) => {
    const errors = validateCheckFields(args)
    if (errors.length) return failure(`Not created:\n- ${errors.join('\n- ')}`)
    const rs = await ruleSetOrFail(args.rule_set_id)
    if (!args.skip_test) {
      const problem = await testCheckSql(rs, args.sql!)
      if (problem) return failure(`Not created — ${problem}`)
    }
    const existing = await dq.listChecks(rs.id)
    const check = await dq.createCheck({
      id: randomUUID(),
      ruleSetId: rs.id,
      name: args.name!.trim(),
      description: args.description?.trim() ?? '',
      category: args.category,
      severity: args.severity,
      threshold: args.threshold ?? 0,
      sql: args.sql,
      order: existing.length,
    })
    return text(`Created.\n${describeCustomCheck(check)}`)
  }))

  server.registerTool('update_dq_check', {
    description: 'Change a custom check of a data-quality rule set (only the fields given). A new SQL is '
      + 'test-run first, like create_dq_check. Generated (builtin / schema) checks cannot be edited.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<CheckFields & { rule_set_id: string; check_id: string; skip_test?: boolean }>({
      type: 'object',
      properties: { rule_set_id: { type: 'string' }, check_id: { type: 'string' }, ...CHECK_FIELDS },
      required: ['rule_set_id', 'check_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const check = (await dq.listChecks(rs.id)).find((c) => c.id === args.check_id)
    if (!check) return failure(`No custom check ${args.check_id} in this rule set (get_dq_rule_set lists them).`)
    const errors = validateCheckFields(args, true)
    if (errors.length) return failure(`Not updated:\n- ${errors.join('\n- ')}`)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) changes.name = args.name.trim()
    if (args.description !== undefined) changes.description = args.description.trim()
    if (args.category !== undefined) changes.category = args.category
    if (args.severity !== undefined) changes.severity = args.severity
    if (args.threshold !== undefined) changes.threshold = args.threshold
    if (args.sql !== undefined) {
      if (!args.skip_test) {
        const problem = await testCheckSql(rs, args.sql)
        if (problem) return failure(`Not updated — ${problem}`)
      }
      changes.sql = args.sql
    }
    if (!Object.keys(changes).length) return failure('Nothing to change.')
    return text(`Updated.\n${describeCustomCheck(await dq.updateCheck(check.id, changes))}`)
  }))

  server.registerTool('delete_dq_checks', {
    description: 'Delete custom checks of a data-quality rule set. Cannot be undone. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_ids: string[] }>({
      type: 'object',
      properties: { rule_set_id: { type: 'string' }, check_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['rule_set_id', 'check_ids'],
    }),
  }, guard(async ({ rule_set_id, check_ids }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const own = new Map((await dq.listChecks(rs.id)).map((c) => [c.id, c]))
    const unknown = check_ids.filter((id) => !own.has(id))
    if (unknown.length) {
      return failure(`Not custom checks of this rule set: ${unknown.join(', ')} (get_dq_rule_set lists them; `
        + 'generated checks cannot be deleted).')
    }
    for (const id of check_ids) await dq.deleteCheck(id)
    return text(`Deleted ${check_ids.length} check(s): ${check_ids.map((id) => own.get(id)!.name).join(', ')}.`)
  }))

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  server.registerTool('run_dq_rule_set', {
    description: 'Run a data-quality rule set on its database: every check (or those matching check_ids / '
      + 'sources / categories / tables), then a summary — score (% of applicable checks passed), counts, and '
      + 'each failed or erroring check with its violated rows. Recorded in the rule set\'s run history like a '
      + 'run from the Data Quality page (record: false for a dry run); only a full run updates the rule set\'s '
      + 'last score. A database with many columns has many checks: filter to go faster.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Filter & { rule_set_id: string; record?: boolean; include_sql?: boolean }>({
      type: 'object',
      properties: {
        rule_set_id: { type: 'string' },
        ...FILTER_FIELDS,
        record: { type: 'boolean', description: 'Save the run in the history (default true).' },
        include_sql: { type: 'boolean', description: 'Show the SQL of the listed checks.' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const { ds, checks } = await allChecks(rs)
    const { checks: selected, unknownIds } = selectChecks(checks, toFilter(args, rs))
    if (unknownIds.length) return failure(`Unknown check id(s): ${unknownIds.join(', ')} (list_dq_checks lists them).`)
    if (!selected.length) return failure('No check matches the filter.')
    const computedAt = new Date().toISOString()
    const results = await runChecks(ds.id, ds.schemaMapping, selected)
    const report: DqReport = makeReport(ds.id, selected, results, computedAt)
    const entry = runEntry(randomUUID(), rs.id, report, new Date().toISOString())
    const partial = isFiltered(args)
    let recorded = 'Not recorded (dry run).'
    if (args.record !== false) {
      if (!partial) {
        await dq.updateRuleSet(rs.id, {
          status: report.summary.failed > 0 ? 'error' : 'success',
          lastRunAt: report.computedAt,
          lastRunDurationMs: entry.durationMs,
          lastScore: entry.score,
        })
      }
      await dq.createRun({ ...entry })
      recorded = `Recorded as run_id ${entry.id}${partial ? ' (partial run: the rule set\'s last score is unchanged)' : ''}.`
    }
    return text(`${formatReport(report, { withSql: args.include_sql })}\n\n${recorded}`)
  }))

  server.registerTool('list_dq_runs', {
    description: 'The run history of a data-quality rule set, newest first: date, score, counts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string; limit?: number }>({
      type: 'object',
      properties: { rule_set_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' } },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, limit }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const runs = await dq.listRuns(rs.id)
    if (!runs.length) return text('No run yet. run_dq_rule_set runs it.')
    const n = limit ?? 20
    const lines = runs.slice(0, n).map((r) =>
      `- run_id ${r.id} · ${r.startedAt} · ${r.status} · score ${r.score ?? '?'}% · ${r.totalChecks} checks: `
      + `${r.passed} passed, ${r.failed} failed, ${r.errors} error(s), ${r.notApplicable} n/a`
      + `${r.durationMs != null ? ` · ${r.durationMs} ms` : ''} · database ${r.dataSourceId}`)
    if (runs.length > n) lines.push(`… ${runs.length - n} older.`)
    return text(lines.join('\n'))
  }))

  server.registerTool('get_dq_run', {
    description: 'The results of one past run of a data-quality rule set (the latest when run_id is omitted): '
      + 'summary, then the checks with the chosen statuses (default: fail and error).',
    annotations: READ,
    inputSchema: fromJsonSchema<{
      rule_set_id: string; run_id?: string; statuses?: DqCheckResult['status'][]; include_sql?: boolean; limit?: number
    }>({
      type: 'object',
      properties: {
        rule_set_id: { type: 'string' },
        run_id: { type: 'string' },
        statuses: { type: 'array', items: { type: 'string', enum: ['pass', 'fail', 'error', 'not_applicable'] } },
        include_sql: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max checks listed (default 60).' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, run_id, statuses, include_sql, limit }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const runs = await dq.listRuns(rs.id)
    const run = run_id ? runs.find((r) => r.id === run_id) : runs[0]
    if (!run) return failure(run_id ? `No run ${run_id} in this rule set (list_dq_runs lists them).` : 'No run yet.')
    const head = `Run ${run.id} of "${loc(rs.name)}" · ${run.startedAt} · ${run.status}`
    const report = run.report as DqReport | undefined
    if (!report?.results) {
      return text(`${head}\nScore ${run.score ?? '?'}% · ${run.passed}/${run.totalChecks} passed, ${run.failed} failed, `
        + `${run.errors} error(s). No per-check detail was stored for this run.`)
    }
    return text(`${head}\n${formatReport(report, { statuses, withSql: include_sql, maxLines: limit })}`)
  }))

  server.registerTool('delete_dq_runs', {
    description: 'Delete runs from a data-quality rule set\'s history: the given run_ids, or all of them. '
      + 'Cannot be undone. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; run_ids?: string[]; all?: boolean }>({
      type: 'object',
      properties: {
        rule_set_id: { type: 'string' },
        run_ids: { type: 'array', items: { type: 'string' } },
        all: { type: 'boolean', description: 'Clear the whole history.' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, run_ids, all }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    if (all) {
      await dq.deleteAllRuns(rs.id)
      return text(`Cleared the run history of "${loc(rs.name)}".`)
    }
    if (!run_ids?.length) return failure('Give run_ids, or all: true.')
    const known = new Set((await dq.listRuns(rs.id)).map((r) => r.id))
    const unknown = run_ids.filter((id) => !known.has(id))
    if (unknown.length) return failure(`Not runs of this rule set: ${unknown.join(', ')} (list_dq_runs lists them).`)
    for (const id of run_ids) await dq.deleteRun(id)
    return text(`Deleted ${run_ids.length} run(s).`)
  }))
}
