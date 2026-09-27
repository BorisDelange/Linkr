/** Data quality: rule sets, their stored checks and groups, runs, investigation. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type { DqCheck, DqCheckResult, DqReport } from '@/lib/duckdb/data-quality-checks'
import { checksFromTemplates, ddlCheckTemplates, makeCheck, mappingCheckTemplates, schemaCheckTemplates, type DqCheckTemplate } from '@/lib/dq-templates'
import type { DqCategory, DqCheckOrigin } from '@/lib/dq-taxonomy'
import { resolvePointer } from '@/lib/import-identity'
import { setLocalized } from '@/lib/localized'
import { injectClassRelations } from '@/lib/schema-classes/inject'
import { RELATION_PREFIX } from '@/lib/schema-classes/contracts'
import { slugifyId, uniqueEntityId } from '@/lib/slugify-id'
import { userToAuthorDetails } from '@/lib/user-identity'
import type { CustomSchemaPreset, DqCustomCheck, DqRuleSet, DqRunHistoryEntry, EntityRef, SchemaMapping, User } from '@/types'
import {
  CATEGORIES, ORIGINS, OTHER_GROUP, SEVERITIES, SUBCATEGORIES, boundedQuery, checkCounts, checkTestProblem,
  describeCheck, errorResult, evaluateRows, formatCheckList, formatReport, formatTemplates, groupChecks, groupKey,
  groupOf, isFiltered, makeReport, missingTemplates, nextEmptyGroups, nextOrder, readCheck, resolveSubcategory, runRecord,
  runnableChecks, selectChecks, summarizeRows, validateCheckFields, type CheckFields, type CheckFilter,
} from './dq.js'
import { reportTranslator, type ReportLanguage } from './report.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, scopedWorkspace, text, type Server } from './shared.js'
import { rest } from './workspace-rest.js'
import { findPreset, sourcePreset } from './workspace.js'

const SET = '/dq-rule-sets'
const CHECK = '/dq-custom-checks'
const enc = encodeURIComponent

const dq = {
  listRuleSets: (workspaceId?: string) =>
    api.request<DqRuleSet[]>('GET', `${SET}${workspaceId ? `?workspaceId=${enc(workspaceId)}` : ''}`),
  getRuleSet: (id: string) => api.request<DqRuleSet>('GET', `${SET}/${enc(id)}`),
  createRuleSet: (body: Record<string, unknown>) => api.request<DqRuleSet>('POST', SET, body),
  updateRuleSet: (id: string, changes: Record<string, unknown>) =>
    api.request<DqRuleSet>('PATCH', `${SET}/${enc(id)}`, changes),
  deleteRuleSet: (id: string) => api.request<void>('DELETE', `${SET}/${enc(id)}`),
  listChecks: async (ruleSetId: string) =>
    (await api.request<DqCustomCheck[]>('GET', `${SET}/${enc(ruleSetId)}/checks`)).map(readCheck),
  createChecks: (ruleSetId: string, checks: DqCustomCheck[]) =>
    api.request<DqCustomCheck[]>('POST', `${SET}/${enc(ruleSetId)}/checks`, checks),
  createCheck: (check: DqCustomCheck) => api.request<DqCustomCheck>('POST', CHECK, check),
  updateCheck: (id: string, changes: Record<string, unknown>) =>
    api.request<DqCustomCheck>('PATCH', `${CHECK}/${enc(id)}`, changes),
  deleteCheck: (id: string) => api.request<void>('DELETE', `${CHECK}/${enc(id)}`),
  listRuns: (ruleSetId: string) => api.request<DqRunHistoryEntry[]>('GET', `${SET}/${enc(ruleSetId)}/runs`),
  createRun: (body: Record<string, unknown>) => api.request<DqRunHistoryEntry>('POST', '/dq-run-history', body),
  deleteRun: (id: string) => api.request<void>('DELETE', `/dq-run-history/${enc(id)}`),
  deleteAllRuns: (ruleSetId: string) => api.request<void>('DELETE', `${SET}/${enc(ruleSetId)}/runs`),
}

const RULE_SET_NOTE = 'A data-quality rule set is a workspace-level list of stored SQL checks run against one '
  + 'clinical database. Checks are generated once from a schema preset (its DDL: columns, NOT NULL, keys; its '
  + 'mapping: what the linkr_* class relations promise) or written by hand, then each can be edited, disabled or '
  + 'deleted. Categories follow Kahn et al. 2016: conformance (value, relational, computational), completeness, '
  + 'plausibility (uniqueness, atemporal, temporal).'

type Lang = { language?: ReportLanguage }
const LANGUAGE = {
  type: 'string', enum: ['en', 'fr'],
  description: 'Language of the text written (names of generated checks, rule set name). Default en.',
} as const

async function ruleSetOrFail(id: string): Promise<DqRuleSet> {
  try {
    return await dq.getRuleSet(id)
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error(`No rule set ${id}. list_dq_rule_sets lists them.`)
    throw e
  }
}

/** The database a rule set may target: it exists and lives in the rule set's workspace. */
async function databaseFor(workspaceId: string, databaseId: string) {
  const ds = await rest.database(databaseId)
  if (ds.workspaceId && ds.workspaceId !== workspaceId) {
    throw new Error(`Database ${databaseId} belongs to another workspace than the rule set.`)
  }
  return ds
}

const pointerOf = (ds: { lineageId?: string | null; entityId?: string | null; name: unknown }) => (ds.lineageId || ds.entityId
  ? { ...(ds.lineageId ? { lineageId: ds.lineageId } : {}), ...(ds.entityId ? { entityId: ds.entityId } : {}), label: ds.name }
  : undefined)

const presetPointer = (preset: CustomSchemaPreset): EntityRef => ({
  ...(preset.lineageId ? { lineageId: preset.lineageId } : {}),
  entityId: preset.entityId,
  label: preset.mapping.presetLabel,
})

const presetLabel = (p: CustomSchemaPreset) => loc(p.mapping.presetLabel) || p.entityId || p.id

const workspacePresets = async (workspaceId: string) =>
  (await rest.presets()).filter((p) => p.workspaceId === workspaceId)

/** The schema whose checks a rule set takes: the one asked for, else the rule
 *  set's own, else its database's, else the first — the Add-checks dialog's order. */
async function presetFor(rs: DqRuleSet, presetId?: string): Promise<CustomSchemaPreset> {
  const presets = await workspacePresets(rs.workspaceId)
  if (presetId) {
    const preset = findPreset(presets, presetId)
    if (!preset) throw new Error(`No schema preset ${presetId} in the rule set's workspace (list_schema_presets lists them).`)
    return preset
  }
  const database = rs.dataSourceId ? await rest.database(rs.dataSourceId).catch(() => null) : null
  const preset = resolvePointer(presets, rs.schemaPresetRef, rs.workspaceId)
    ?? (database ? sourcePreset(database, presets) : undefined)
    ?? presets[0]
  if (!preset) throw new Error('No schema preset in this workspace: install one from the catalog in Linkr.')
  return preset
}

async function translator(language: ReportLanguage = 'en') {
  const t = await reportTranslator(language)
  return (key: string, vars?: Record<string, unknown>) => t(key, vars ?? {}) as string
}

/** The server runs SQL as sent: `linkr_*` relations are resolved here, with the
 *  database's mapping read once per call. */
async function querier(databaseId: string) {
  const ds = await api.getDataSource(databaseId)
  if (ds.status && ds.status !== 'connected') throw new Error(`Database ${ds.id} is ${ds.status}: it cannot be queried.`)
  const mapping: SchemaMapping | null | undefined = ds.schemaMapping
  return async (sql: string) => (await api.request<{ rows: Record<string, unknown>[] }>(
    'POST', `/data-sources/${enc(ds.id)}/query`,
    { sql: sql.toLowerCase().includes(RELATION_PREFIX) ? injectClassRelations(sql, mapping) : sql },
  )).rows
}

function needDatabase(rs: DqRuleSet): string {
  if (!rs.dataSourceId) throw new Error('This rule set has no database yet: set one with update_dq_rule_set (database_id).')
  return rs.dataSourceId
}

async function runChecks(query: (sql: string) => Promise<Record<string, unknown>[]>, checks: DqCheck[]) {
  const results: DqCheckResult[] = new Array(checks.length)
  let next = 0
  const worker = async () => {
    while (next < checks.length) {
      const i = next++
      const start = performance.now()
      try {
        results[i] = evaluateRows(checks[i], await query(checks[i].sql), Math.round(performance.now() - start))
      } catch (e) {
        results[i] = errorResult(checks[i], e, Math.round(performance.now() - start))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, checks.length) }, worker))
  return results
}

/** The Test button: the check's SQL on the rule set's database, and what it says. */
async function testCheck(rs: DqRuleSet, sql: string, threshold: number): Promise<{ problem: string | null; line: string }> {
  const query = await querier(needDatabase(rs))
  let rows: Record<string, unknown>[]
  try {
    rows = await query(sql)
  } catch (e) {
    return { problem: `The SQL failed on database ${rs.dataSourceId}: ${(e as Error).message}`, line: '' }
  }
  const problem = checkTestProblem(rows)
  if (problem) return { problem, line: '' }
  const r = evaluateRows({ id: '', sql, threshold } as DqCheck, rows, 0)
  return {
    problem: null,
    line: `Test run: ${r.status} — ${r.violatedRows}/${r.totalRows} violated (${r.pctViolated.toFixed(2)}%, threshold ${threshold}%).`,
  }
}

function describeRuleSet(rs: DqRuleSet): string {
  const lines = [
    `Rule set "${loc(rs.name)}" — rule_set_id: ${rs.id}${rs.entityId ? ` · entity id ${rs.entityId}` : ''}`,
    `Workspace ${rs.workspaceId} · database ${rs.dataSourceId || '(none)'} · schema ${loc(rs.schemaPresetRef?.label) || '(none)'}`
      + ` · status ${rs.status} · version ${rs.version ?? '0.1.0'}`,
  ]
  if (loc(rs.description)) lines.push(`Description: ${loc(rs.description).slice(0, 800)}`)
  if (rs.lastRunAt) lines.push(`Last run ${rs.lastRunAt}: score ${rs.lastScore ?? '?'}%${rs.lastRunDurationMs != null ? ` in ${rs.lastRunDurationMs} ms` : ''}`)
  return lines.join('\n')
}

const runLine = (r: DqRunHistoryEntry) =>
  `- run_id ${r.id} · ${r.startedAt} · ${r.status} · score ${r.score ?? '?'}% · ${r.totalChecks} checks: `
  + `${r.passed} passed, ${r.failed} failed, ${r.errors} error(s), ${r.notApplicable} n/a`
  + `${r.durationMs != null ? ` · ${r.durationMs} ms` : ''} · database ${r.dataSourceId}`

const newestFirst = (runs: DqRunHistoryEntry[]) => [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))

async function checkOrFail(rs: DqRuleSet, checkId: string): Promise<{ check: DqCustomCheck; all: DqCustomCheck[] }> {
  const all = await dq.listChecks(rs.id)
  const check = all.find((c) => c.id === checkId)
  if (!check) throw new Error(`No check ${checkId} in this rule set (list_dq_checks lists them).`)
  return { check, all }
}

async function updateMany(ids: string[], changes: Record<string, unknown>) {
  for (const id of ids) await dq.updateCheck(id, changes)
}

function unknownIds(all: DqCustomCheck[], ids: string[]): string | null {
  const known = new Set(all.map((c) => c.id))
  const unknown = ids.filter((id) => !known.has(id))
  return unknown.length ? `Not checks of this rule set: ${unknown.join(', ')} (list_dq_checks lists them).` : null
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const RULE_SET_ID = { rule_set_id: { type: 'string' } } as const

const CHECK_FIELDS = {
  name: { type: 'string', description: 'Short name shown in the check list.' },
  description: { type: 'string', description: 'What the check verifies (shown in results).' },
  category: { type: 'string', enum: CATEGORIES, description: 'Kahn category. Default for a new check: plausibility.' },
  subcategory: {
    type: ['string', 'null'], enum: [...SUBCATEGORIES, null],
    description: 'conformance: value, relational, computational · completeness: none · plausibility: uniqueness, '
      + 'atemporal, temporal. Omitted: kept if it fits the category, else the category\'s first.',
  },
  severity: { type: 'string', enum: SEVERITIES, description: 'Default for a new check: warning.' },
  threshold: {
    type: 'number', minimum: 0, maximum: 100,
    description: 'Max % of violated rows allowed before the check fails; 0 (default) = any violated row fails.',
  },
  sql: {
    type: 'string',
    description: 'A query on the rule set\'s database returning ONE row with violated_rows and total_rows (bigint), '
      + 'e.g. SELECT COUNT(*) FILTER (WHERE end_datetime < start_datetime)::BIGINT AS violated_rows, COUNT(*)::BIGINT '
      + 'AS total_rows FROM linkr_visit. Raw table names (describe_database) and the class relations (linkr_patient, '
      + 'linkr_visit, linkr_event_<key>…) both work. total_rows = 0 → not applicable.',
  },
  explore_sql: {
    type: ['string', 'null'],
    description: 'Lists the rows breaking the rule, to investigate a failure: same table and condition as sql, '
      + 'without COUNT, ending with LIMIT 100. null clears it.',
  },
  group: {
    type: ['string', 'null'],
    description: 'The group the check is listed under (usually its table or relation); null = "Other checks".',
  },
  skip_test: {
    type: 'boolean',
    description: 'Save without test-running the SQL on the database (default false: a failing SQL is refused).',
  },
} as const

const FILTER_FIELDS = {
  check_ids: { type: 'array', items: { type: 'string' }, description: 'Only these checks (ids from list_dq_checks).' },
  origins: { type: 'array', items: { type: 'string', enum: ORIGINS }, description: 'ddl / mapping (generated from a schema) or manual.' },
  categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
  groups: { type: 'array', items: { type: 'string' }, description: `Only checks of these groups ("${OTHER_GROUP}" or "" for the ungrouped).` },
  search: { type: 'string', description: 'Substring of the check name or group.' },
} as const

type Filter = {
  check_ids?: string[]; origins?: DqCheckOrigin[]; categories?: DqCategory[]; groups?: string[]; search?: string
}
const toFilter = (f: Filter, state?: CheckFilter['state']): CheckFilter => ({
  checkIds: f.check_ids, origins: f.origins, categories: f.categories, groups: f.groups, search: f.search, state,
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
    const sets = await dq.listRuleSets(await scopedWorkspace(args))
    if (!sets.length) return text('No data-quality rule set. create_dq_rule_set makes one.')
    return text(sets.map((rs) =>
      `- "${loc(rs.name)}" — rule_set_id: ${rs.id} · database ${rs.dataSourceId || '(none)'} · ${rs.status}`
      + `${rs.schemaPresetRef ? ` · schema ${loc(rs.schemaPresetRef.label)}` : ''}`
      + `${rs.lastScore != null ? ` · last score ${rs.lastScore}% (${rs.lastRunAt})` : ''}`,
    ).join('\n'))
  }))

  server.registerTool('get_dq_rule_set', {
    description: 'A data-quality rule set: its database and schema, last score, its checks counted by origin, '
      + 'category and group, and its recent runs. list_dq_checks lists the checks.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string }>({ type: 'object', properties: RULE_SET_ID, required: ['rule_set_id'] }),
  }, guard(async ({ rule_set_id }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const [checks, runs] = await Promise.all([dq.listChecks(rs.id), dq.listRuns(rs.id)])
    const groups = groupChecks(checks, rs.checkGroups ?? [])
    const out = [describeRuleSet(rs), '', `Checks: ${checkCounts(checks, rs.checkGroups ?? [])}`]
    if (groups.length) {
      out.push(`Groups: ${groups.slice(0, 60).map((g) => `${g.name || OTHER_GROUP} ${g.checks.length}`).join(', ')}`
        + `${groups.length > 60 ? `, … ${groups.length - 60} more` : ''}`)
    }
    const sorted = newestFirst(runs)
    out.push('', `Runs (${runs.length}):`, ...sorted.slice(0, 10).map(runLine))
    if (runs.length > 10) out.push(`… ${runs.length - 10} older (list_dq_runs).`)
    return text(out.join('\n'))
  }))

  server.registerTool('create_dq_rule_set', {
    description: `Create a data-quality rule set, as the New rule set dialog does. ${RULE_SET_NOTE} It lives in a `
      + 'workspace (workspace_id, or project_uid for its workspace) and targets one database of it (database_id; '
      + 'optional, as in the app, but needed to run). It starts with every check generated from a schema preset: '
      + 'schema_preset_id, by default the preset the database\'s schema came from; "none" for an empty rule set. '
      + 'Then run_dq_rule_set.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Lang & {
      name: string; description?: string; database_id?: string; workspace_id?: string; project_uid?: string
      schema_preset_id?: string; entity_id?: string; version?: string
    }>({
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        database_id: { type: 'string' },
        workspace_id: { type: 'string' },
        project_uid: { type: 'string', description: 'Alternative to workspace_id: the workspace of this project.' },
        schema_preset_id: {
          type: 'string',
          description: 'Preset (id or entity id, from list_schema_presets) whose DDL and mapping checks the rule set starts with; "none" for none.',
        },
        entity_id: {
          type: 'string',
          description: 'Readable identifier (lowercase, digits, hyphens; unique in the workspace). Default: from the name.',
        },
        version: { type: 'string', description: 'Semver, default 0.1.0.' },
        language: LANGUAGE,
      },
      required: ['name'],
    }),
  }, guard(async (args) => {
    const name = args.name.trim()
    if (!name) return failure('name must not be empty.')
    const workspaceId = await scopedWorkspace(args)
    if (!workspaceId) return failure('Give workspace_id or project_uid: a rule set lives in a workspace.')
    const ds = args.database_id ? await databaseFor(workspaceId, args.database_id) : undefined
    const taken = (await dq.listRuleSets(workspaceId)).map((r) => r.entityId).filter((x): x is string => !!x)
    let entityId: string
    if (args.entity_id) {
      if (args.entity_id.length < 2 || args.entity_id.length > 50 || slugifyId(args.entity_id) !== args.entity_id) {
        return failure('entity_id: 2–50 characters, lowercase letters, digits and inner hyphens only.')
      }
      if (taken.includes(args.entity_id)) return failure(`entity_id "${args.entity_id}" is already used in this workspace.`)
      entityId = args.entity_id
    } else {
      entityId = uniqueEntityId(slugifyId(name), taken)
    }
    let preset: CustomSchemaPreset | undefined
    if (args.schema_preset_id !== 'none') {
      const presets = await workspacePresets(workspaceId)
      preset = args.schema_preset_id ? findPreset(presets, args.schema_preset_id) : ds && sourcePreset(ds, presets)
      if (args.schema_preset_id && !preset) {
        return failure(`No schema preset ${args.schema_preset_id} in this workspace (list_schema_presets lists them).`)
      }
    }
    const lang = args.language ?? 'en'
    const templates = preset ? schemaCheckTemplates(preset.mapping, await translator(lang)) : []
    const me = await api.request<Partial<User> & { id: number; username: string }>('GET', '/auth/me')
    const now = new Date().toISOString()
    const pointer = ds ? pointerOf(ds) : undefined
    const id = randomUUID()
    const rs = await dq.createRuleSet({
      id,
      entityId,
      workspaceId,
      name: setLocalized(undefined, lang, name),
      description: setLocalized(undefined, lang, args.description?.trim() ?? ''),
      dataSourceId: ds?.id ?? '',
      ...(pointer ? { dataSourceRef: pointer } : {}),
      ...(preset ? { schemaPresetRef: presetPointer(preset) } : {}),
      badges: [],
      status: 'draft',
      version: args.version?.trim() || '0.1.0',
      createdById: me.id,
      createdBy: `${me.firstName ?? ''} ${me.lastName ?? ''}`.trim() || me.username,
      createdByDetails: userToAuthorDetails(me),
      lineageId: randomUUID(),
      createdAt: now,
    })
    if (templates.length) await dq.createChecks(id, checksFromTemplates(id, templates))
    const ddl = templates.filter((c) => c.origin === 'ddl').length
    return text(`Created.\n\n${describeRuleSet(rs)}\n\n${preset
      ? `${templates.length} check(s) generated from "${presetLabel(preset)}": ${ddl} from its DDL, ${templates.length - ddl} from its mapping.`
      : 'No schema: the rule set has no check yet (add_dq_schema_checks, create_dq_check).'}`)
  }))

  server.registerTool('update_dq_rule_set', {
    description: 'Change a data-quality rule set: name, description, database, version. Its checks stay as they '
      + 'are; changing the database changes what the next run checks.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Lang & {
      rule_set_id: string; name?: string; description?: string; database_id?: string; version?: string
    }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        name: { type: 'string' },
        description: { type: 'string' },
        database_id: { type: 'string' },
        version: { type: 'string' },
        language: { ...LANGUAGE, description: 'Language of name and description (others kept). Default en.' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, name, description, database_id, version, language }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const lang = language ?? 'en'
    const changes: Record<string, unknown> = {}
    if (name !== undefined) {
      if (!name.trim()) return failure('name must not be empty.')
      changes.name = setLocalized(rs.name, lang, name.trim())
    }
    if (description !== undefined) changes.description = setLocalized(rs.description, lang, description.trim())
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
    description: 'Delete a data-quality rule set with its checks and run history. Cannot be undone. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string }>({ type: 'object', properties: RULE_SET_ID, required: ['rule_set_id'] }),
  }, guard(async ({ rule_set_id }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    await dq.deleteRuleSet(rs.id)
    return text(`Deleted rule set "${loc(rs.name)}" (${rs.id}).`)
  }))

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  server.registerTool('list_dq_checks', {
    description: 'The checks of a data-quality rule set by group, as the Checks tab lists them: id, name, '
      + 'category/subcategory, severity, threshold, origin (ddl / mapping / manual), disabled ones marked. '
      + 'Filter by origin, category, group, state or name.',
    annotations: READ,
    inputSchema: fromJsonSchema<Filter & { rule_set_id: string; state?: CheckFilter['state']; include_sql?: boolean; limit?: number }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        ...FILTER_FIELDS,
        state: { type: 'string', enum: ['all', 'enabled', 'disabled'], description: 'Default all.' },
        include_sql: { type: 'boolean', description: 'Show each check\'s SQL and explore SQL.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max checks listed (default 200).' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const all = await dq.listChecks(rs.id)
    if (!all.length) return text(`"${loc(rs.name)}" has no check yet: add_dq_schema_checks or create_dq_check.`)
    const { checks, unknownIds: unknown } = selectChecks(all, toFilter(args, args.state))
    return text([
      `Checks of "${loc(rs.name)}" — ${checks.length} of ${all.length}${unknown.length ? ` (unknown ids: ${unknown.join(', ')})` : ''}.`,
      'A check fails when violated_rows > 0 (threshold 0) or its % of violated rows exceeds the threshold; '
        + 'disabled checks stay listed but are left out of runs and of the score.',
      '',
      formatCheckList(checks, {
        withSql: args.include_sql, max: args.limit, emptyGroups: isFiltered(toFilter(args, args.state)) ? [] : rs.checkGroups ?? [],
      }),
    ].join('\n'))
  }))

  server.registerTool('get_dq_check', {
    description: 'One check of a data-quality rule set in full: its fields, the schema rule that generated it '
      + '(templateKey), its SQL and its explore SQL (the query investigate_dq_check runs).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_id: string }>({
      type: 'object', properties: { ...RULE_SET_ID, check_id: { type: 'string' } }, required: ['rule_set_id', 'check_id'],
    }),
  }, guard(async ({ rule_set_id, check_id }) => {
    const { check: c } = await checkOrFail(await ruleSetOrFail(rule_set_id), check_id)
    return text([
      describeCheck(c),
      `Group: ${c.tableName ?? OTHER_GROUP} · order ${c.order}${c.templateKey ? ` · generated by ${c.templateKey}` : ' · written by hand'}`,
      ...(c.description ? [`Description: ${c.description}`] : []),
      '', 'SQL:', c.sql,
      '', 'Explore SQL:', c.exploreSql?.trim() ? c.exploreSql : '(none: investigating falls back to the SQL above)',
    ].join('\n'))
  }))

  server.registerTool('add_dq_schema_checks', {
    description: 'Add a schema preset\'s DDL or mapping checks to a rule set, as the Checks tab\'s "Add from DDL / '
      + 'from mapping" dialog does. Only the checks the rule set does not hold yet are offered (matched on the rule '
      + 'that generates them), so this also brings a rule set up to date with its schema or restores a deleted '
      + 'check. list_only first shows what is missing; then add all of it, or the template_keys / tables chosen.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Lang & {
      rule_set_id: string; origin: 'ddl' | 'mapping'; schema_preset_id?: string; list_only?: boolean
      template_keys?: string[]; tables?: string[]
    }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        origin: { type: 'string', enum: ['ddl', 'mapping'], description: 'The preset\'s DDL (tables, NOT NULL, keys) or its mapping (linkr_* relations).' },
        schema_preset_id: {
          type: 'string',
          description: 'Default: the rule set\'s schema, else its database\'s, else the workspace\'s first preset.',
        },
        list_only: { type: 'boolean', description: 'List the missing checks without adding any.' },
        template_keys: { type: 'array', items: { type: 'string' }, description: 'Only these (keys from list_only).' },
        tables: { type: 'array', items: { type: 'string' }, description: 'Only the checks of these tables / relations.' },
        language: LANGUAGE,
      },
      required: ['rule_set_id', 'origin'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const preset = await presetFor(rs, args.schema_preset_id)
    const t = await translator(args.language)
    const all: DqCheckTemplate[] = args.origin === 'ddl'
      ? (preset.mapping.ddl ? ddlCheckTemplates(preset.mapping.ddl, t) : [])
      : mappingCheckTemplates(preset.mapping, t)
    const stored = await dq.listChecks(rs.id)
    const { missing, presentCount } = missingTemplates(all, stored)
    const head = `Schema "${presetLabel(preset)}", ${args.origin}: ${missing.length} check(s) missing, ${presentCount} already in the rule set.`
    if (args.origin === 'ddl' && !preset.mapping.ddl) return text(`${head} This preset has no DDL.`)
    const tables = args.tables?.length ? new Set(args.tables.map((x) => x.toLowerCase())) : null
    const keys = args.template_keys?.length ? new Set(args.template_keys) : null
    const picked = missing.filter((c) => (!tables || tables.has(c.tableName.toLowerCase())) && (!keys || keys.has(c.templateKey)))
    if (keys) {
      const unknown = [...keys].filter((k) => !missing.some((c) => c.templateKey === k))
      if (unknown.length) return failure(`${head}\nNot among the missing checks: ${unknown.join(', ')} (list_only lists them).`)
    }
    if (args.list_only || !picked.length) {
      return text(`${head}${picked.length ? `\n\n${formatTemplates(picked)}` : missing.length ? '\nNone matches the filter.' : ''}`)
    }
    await dq.createChecks(rs.id, checksFromTemplates(rs.id, picked, nextOrder(stored)))
    if (!rs.schemaPresetRef) await dq.updateRuleSet(rs.id, { schemaPresetRef: presetPointer(preset) })
    return text(`${head}\nAdded ${picked.length} check(s), enabled, at the end of the list.`)
  }))

  server.registerTool('create_dq_check', {
    description: 'Add a hand-written SQL check to a data-quality rule set (origin manual). The SQL runs on the rule '
      + 'set\'s database and returns one row with violated_rows and total_rows; it is test-run first and refused '
      + 'if it fails (unless skip_test). Give an explore_sql too, so a failure can be investigated.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<CheckFields & { rule_set_id: string; skip_test?: boolean }>({
      type: 'object',
      properties: { ...RULE_SET_ID, ...CHECK_FIELDS },
      required: ['rule_set_id', 'name', 'sql'],
    }),
  }, guard(async (args) => {
    const errors = validateCheckFields(args)
    if (errors.length) return failure(`Not created:\n- ${errors.join('\n- ')}`)
    const rs = await ruleSetOrFail(args.rule_set_id)
    const threshold = args.threshold ?? 0
    let tested = ''
    if (!args.skip_test) {
      const { problem, line } = await testCheck(rs, args.sql!, threshold)
      if (problem) return failure(`Not created — ${problem}`)
      tested = `\n${line}`
    }
    const stored = await dq.listChecks(rs.id)
    const category = (args.category ?? 'plausibility') as DqCategory
    const check = await dq.createCheck(makeCheck(rs.id, nextOrder(stored), {
      name: args.name!.trim(),
      description: args.description?.trim() ?? '',
      category,
      subcategory: args.category === undefined && args.subcategory === undefined ? 'atemporal' : resolveSubcategory(category, args.subcategory, null),
      severity: (args.severity ?? 'warning') as DqCustomCheck['severity'],
      threshold,
      sql: args.sql!,
      exploreSql: args.explore_sql?.trim() ? args.explore_sql : null,
      origin: 'manual',
      templateKey: null,
      tableName: args.group?.trim() ? groupKey(args.group) || null : null,
    }))
    return text(`Created.\n${describeCheck(readCheck(check))}${tested}`)
  }))

  server.registerTool('update_dq_check', {
    description: 'Change a check of a data-quality rule set, generated or hand-written (only the fields given): '
      + 'name, description, category/subcategory, severity, threshold, SQL, explore SQL, group. A new SQL is '
      + 'test-run first, like create_dq_check. Enabling / disabling is set_dq_checks_enabled.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<CheckFields & { rule_set_id: string; check_id: string; skip_test?: boolean }>({
      type: 'object',
      properties: { ...RULE_SET_ID, check_id: { type: 'string' }, ...CHECK_FIELDS },
      required: ['rule_set_id', 'check_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const { check } = await checkOrFail(rs, args.check_id)
    const errors = validateCheckFields(args, check)
    if (errors.length) return failure(`Not updated:\n- ${errors.join('\n- ')}`)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) changes.name = args.name.trim()
    if (args.description !== undefined) changes.description = args.description.trim()
    if (args.category !== undefined || args.subcategory !== undefined) {
      const category = (args.category ?? check.category) as DqCategory
      if (args.category !== undefined) changes.category = category
      changes.subcategory = resolveSubcategory(category, args.subcategory, check.subcategory)
    }
    if (args.severity !== undefined) changes.severity = args.severity
    if (args.threshold !== undefined) changes.threshold = args.threshold
    if (args.explore_sql !== undefined) changes.exploreSql = args.explore_sql?.trim() ? args.explore_sql : null
    if (args.group !== undefined) changes.tableName = groupKey(args.group) || null
    let tested = ''
    if (args.sql !== undefined) {
      if (!args.skip_test) {
        const { problem, line } = await testCheck(rs, args.sql, args.threshold ?? check.threshold)
        if (problem) return failure(`Not updated — ${problem}`)
        tested = `\n${line}`
      }
      changes.sql = args.sql
    }
    if (!Object.keys(changes).length) return failure('Nothing to change.')
    return text(`Updated.\n${describeCheck(readCheck(await dq.updateCheck(check.id, changes)))}${tested}`)
  }))

  server.registerTool('test_dq_check', {
    description: 'The Checks tab\'s Test button: run a check\'s SQL (a stored check, or an sql not saved yet) on '
      + 'the rule set\'s database and say whether it passes, with its counts. Changes nothing.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_id?: string; sql?: string; threshold?: number }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        check_id: { type: 'string' },
        sql: { type: 'string', description: 'A draft SQL instead of a stored check\'s.' },
        threshold: { type: 'number', minimum: 0, maximum: 100, description: 'Default: the check\'s, else 0.' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, check_id, sql, threshold }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const check = check_id ? (await checkOrFail(rs, check_id)).check : undefined
    const query = sql ?? check?.sql
    if (!query?.trim()) return failure('Give check_id or sql.')
    const { problem, line } = await testCheck(rs, query, threshold ?? check?.threshold ?? 0)
    return problem ? failure(problem) : text(`${check ? `${check.name}: ` : ''}${line}`)
  }))

  server.registerTool('set_dq_checks_enabled', {
    description: 'Enable or disable checks of a data-quality rule set (saved). A disabled check stays in the list '
      + 'but is left out of runs and of the score. Pick them by check_ids, or by filter (groups, origins, categories).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Filter & { rule_set_id: string; enabled: boolean }>({
      type: 'object',
      properties: { ...RULE_SET_ID, enabled: { type: 'boolean' }, ...FILTER_FIELDS },
      required: ['rule_set_id', 'enabled'],
    }),
  }, guard(async (args) => {
    if (!isFiltered(toFilter(args))) return failure('Say which checks: check_ids, groups, origins, categories or search.')
    const rs = await ruleSetOrFail(args.rule_set_id)
    const all = await dq.listChecks(rs.id)
    const { checks, unknownIds: unknown } = selectChecks(all, toFilter(args))
    if (unknown.length) return failure(`Not checks of this rule set: ${unknown.join(', ')} (list_dq_checks lists them).`)
    const changing = checks.filter((c) => c.disabled === args.enabled)
    await updateMany(changing.map((c) => c.id), { disabled: !args.enabled })
    const enabled = all.filter((c) => (changing.includes(c) ? args.enabled : !c.disabled)).length
    return text(`${args.enabled ? 'Enabled' : 'Disabled'} ${changing.length} check(s)`
      + `${checks.length > changing.length ? ` (${checks.length - changing.length} already ${args.enabled ? 'enabled' : 'disabled'})` : ''}. `
      + `${enabled}/${all.length} checks now run.`)
  }))

  server.registerTool('delete_dq_checks', {
    description: 'Delete checks of a data-quality rule set, generated or hand-written. Cannot be undone (a '
      + 'generated one can be added back with add_dq_schema_checks). Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_ids: string[] }>({
      type: 'object',
      properties: { ...RULE_SET_ID, check_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['rule_set_id', 'check_ids'],
    }),
  }, guard(async ({ rule_set_id, check_ids }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const all = await dq.listChecks(rs.id)
    const problem = unknownIds(all, check_ids)
    if (problem) return failure(problem)
    for (const id of check_ids) await dq.deleteCheck(id)
    const names = check_ids.map((id) => all.find((c) => c.id === id)!.name)
    return text(`Deleted ${check_ids.length} check(s): ${names.slice(0, 30).join(', ')}${names.length > 30 ? ', …' : ''}.`)
  }))

  // ---------------------------------------------------------------------------
  // Groups — a group is the `tableName` its checks share
  // ---------------------------------------------------------------------------

  /** Keep the rule set's empty groups in step after a group change. */
  async function saveEmptyGroups(rs: DqRuleSet, checks: DqCustomCheck[], change: Parameters<typeof nextEmptyGroups>[2]) {
    const next = nextEmptyGroups(rs.checkGroups, checks, change)
    const same = JSON.stringify(next ?? []) === JSON.stringify(rs.checkGroups ?? [])
    if (!same) await dq.updateRuleSet(rs.id, { checkGroups: next })
  }

  server.registerTool('create_dq_check_group', {
    description: 'Create an empty group of checks in a data-quality rule set, as the sidebar\'s New group does; '
      + 'move_dq_checks or create_dq_check (group) then fills it. It is kept while it holds no check.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; name: string }>({
      type: 'object', properties: { ...RULE_SET_ID, name: { type: 'string' } }, required: ['rule_set_id', 'name'],
    }),
  }, guard(async ({ rule_set_id, name }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const group = groupKey(name)
    if (!group) return failure(`name must be a name other than "${OTHER_GROUP}".`)
    const checks = await dq.listChecks(rs.id)
    const existing = [...checks.map(groupOf), ...(rs.checkGroups ?? [])].find((g) => g && g.toLowerCase() === group.toLowerCase())
    if (existing) return failure(`A group "${existing}" already exists.`)
    await saveEmptyGroups(rs, checks, { add: group })
    return text(`Created the group "${group}" (empty).`)
  }))

  server.registerTool('move_dq_checks', {
    description: 'Move checks of a data-quality rule set to a group (an existing one or a new name), or to "Other '
      + 'checks" with group null.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_ids: string[]; group: string | null }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        check_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        group: { type: ['string', 'null'] },
      },
      required: ['rule_set_id', 'check_ids', 'group'],
    }),
  }, guard(async ({ rule_set_id, check_ids, group }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const all = await dq.listChecks(rs.id)
    const problem = unknownIds(all, check_ids)
    if (problem) return failure(problem)
    const target = groupKey(group)
    // Same name, other case: the dialog refuses it as a clash, so it joins the existing group.
    const existing = [...new Set(all.map(groupOf))].find((g) => g && g.toLowerCase() === target.toLowerCase())
    const name = existing ?? target
    await updateMany(check_ids, { tableName: name || null })
    await saveEmptyGroups(rs, await dq.listChecks(rs.id), {})
    return text(`Moved ${check_ids.length} check(s) to ${name ? `"${name}"${existing ? '' : ' (new group)'}` : `"${OTHER_GROUP}"`}.`)
  }))

  server.registerTool('rename_dq_check_group', {
    description: 'Rename a group of checks in a data-quality rule set (all its checks move with it). The new name '
      + 'must not be another group\'s.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; group: string; new_name: string }>({
      type: 'object',
      properties: { ...RULE_SET_ID, group: { type: 'string' }, new_name: { type: 'string' } },
      required: ['rule_set_id', 'group', 'new_name'],
    }),
  }, guard(async ({ rule_set_id, group, new_name }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const all = await dq.listChecks(rs.id)
    const from = groupKey(group)
    if (!from) return failure(`"${OTHER_GROUP}" cannot be renamed: move its checks with move_dq_checks.`)
    const to = new_name.trim()
    if (!to || !groupKey(to)) return failure(`new_name must be a name other than "${OTHER_GROUP}".`)
    const ids = all.filter((c) => groupOf(c) === from).map((c) => c.id)
    const empty = rs.checkGroups ?? []
    if (!ids.length && !empty.includes(from)) return failure(`No group "${from}" in this rule set (list_dq_checks lists them).`)
    if (to === from) return text('Same name: nothing to do.')
    const others = [...all.map(groupOf), ...empty].filter((g) => g && g !== from)
    if (others.some((g) => g.toLowerCase() === to.toLowerCase())) {
      return failure(`A group "${to}" already exists: move the checks into it with move_dq_checks instead.`)
    }
    if (ids.length) await updateMany(ids, { tableName: to })
    await saveEmptyGroups(rs, await dq.listChecks(rs.id), { rename: [from, to] })
    return text(`Renamed "${from}" to "${to}" (${ids.length} check(s)).`)
  }))

  server.registerTool('delete_dq_check_group', {
    description: 'Delete a group of checks in a data-quality rule set: with its checks (with_checks true; cannot '
      + 'be undone, ask the user first), or keeping them under "Other checks". Deleting "Other checks" deletes its checks.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ rule_set_id: string; group: string; with_checks: boolean }>({
      type: 'object',
      properties: { ...RULE_SET_ID, group: { type: 'string' }, with_checks: { type: 'boolean' } },
      required: ['rule_set_id', 'group', 'with_checks'],
    }),
  }, guard(async ({ rule_set_id, group, with_checks }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const name = groupKey(group)
    const ids = (await dq.listChecks(rs.id)).filter((c) => groupOf(c) === name).map((c) => c.id)
    if (!ids.length && (rs.checkGroups ?? []).includes(name)) {
      await saveEmptyGroups(rs, [], { remove: name })
      return text(`Deleted the empty group "${name}".`)
    }
    if (!ids.length) return failure(`No group "${group}" in this rule set (list_dq_checks lists them).`)
    if (!name && !with_checks) return failure(`Keeping the checks of "${OTHER_GROUP}" would leave them where they are: pass with_checks true to delete them.`)
    if (with_checks) {
      for (const id of ids) await dq.deleteCheck(id)
      return text(`Deleted the group "${name || OTHER_GROUP}" and its ${ids.length} check(s).`)
    }
    await updateMany(ids, { tableName: null })
    return text(`Deleted the group "${name}"; its ${ids.length} check(s) are now under "${OTHER_GROUP}".`)
  }))

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  server.registerTool('run_dq_rule_set', {
    description: 'Run a data-quality rule set on its database: every enabled check (or those of check_ids / '
      + 'origins / categories / groups / search), then a summary — score (% of applicable checks passed), counts '
      + 'per category and severity, each failed or erroring check with its violated rows. Recorded like a run from '
      + 'the page (run history + the rule set\'s last run and score); record false for a dry run. A partial run '
      + 'goes in the history but leaves the last score alone. investigate_dq_check then looks at a failure.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<Filter & { rule_set_id: string; record?: boolean; include_sql?: boolean; limit?: number }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        ...FILTER_FIELDS,
        record: { type: 'boolean', description: 'Save the run (default true).' },
        include_sql: { type: 'boolean', description: 'Show the SQL of the listed checks.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max checks listed (default 60).' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async (args) => {
    const rs = await ruleSetOrFail(args.rule_set_id)
    const dataSourceId = needDatabase(rs)
    const stored = await dq.listChecks(rs.id)
    const filter = toFilter(args)
    const { checks: picked, unknownIds: unknown } = selectChecks(stored, filter)
    if (unknown.length) return failure(`Unknown check id(s): ${unknown.join(', ')} (list_dq_checks lists them).`)
    const disabledAsked = args.check_ids?.length ? picked.filter((c) => c.disabled) : []
    const checks = runnableChecks(picked)
    if (!checks.length) {
      return failure(disabledAsked.length
        ? `Only disabled checks picked (${disabledAsked.map((c) => c.id).join(', ')}): enable them with set_dq_checks_enabled.`
        : stored.length ? 'No enabled check matches.' : 'The rule set has no check yet: add_dq_schema_checks or create_dq_check.')
    }
    const query = await querier(dataSourceId)
    const computedAt = new Date().toISOString()
    const results = await runChecks(query, checks)
    const report: DqReport = makeReport(dataSourceId, checks, results, computedAt)
    const { ruleSetChanges, entry } = runRecord(randomUUID(), { id: rs.id, dataSourceId }, report, new Date().toISOString())
    const partial = isFiltered(filter)
    let recorded = 'Not recorded (dry run).'
    if (args.record !== false) {
      if (!partial) await dq.updateRuleSet(rs.id, ruleSetChanges)
      await dq.createRun({ ...entry })
      recorded = `Recorded as run_id ${entry.id}${partial ? ' (partial run: the rule set\'s last score is unchanged)' : ''}.`
    }
    const skipped = disabledAsked.length ? `\nSkipped ${disabledAsked.length} disabled check(s): ${disabledAsked.map((c) => c.id).join(', ')}.` : ''
    return text(`${formatReport(report, { withSql: args.include_sql, maxLines: args.limit })}${skipped}\n\n${recorded}`)
  }))

  server.registerTool('investigate_dq_check', {
    description: 'Look at why a check fails, as the Investigate button does: re-counts its violated rows, then runs '
      + 'its explore SQL (the rows breaking the rule) on the rule set\'s database. By default returns only an '
      + 'aggregate view of those rows (per column: filled, distinct, range, frequent values; identifier columns '
      + 'as counts only). Patient-level rows only with rows: true, when the user asked to see them.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string; check_id: string; rows?: boolean; limit?: number; sample?: number }>({
      type: 'object',
      properties: {
        ...RULE_SET_ID,
        check_id: { type: 'string' },
        rows: { type: 'boolean', description: 'Return the failing rows themselves (default false: aggregates only).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows returned with rows: true (default 20).' },
        sample: { type: 'integer', minimum: 1, maximum: 5000, description: 'Failing rows read for the aggregates (default 1000).' },
      },
      required: ['rule_set_id', 'check_id'],
    }),
  }, guard(async ({ rule_set_id, check_id, rows, limit, sample }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const { check } = await checkOrFail(rs, check_id)
    const query = await querier(needDatabase(rs))
    const out = [describeCheck(check)]
    const start = performance.now()
    try {
      const r = evaluateRows(runnableChecks([{ ...check, disabled: false }])[0], await query(check.sql), Math.round(performance.now() - start))
      out.push(`Now: ${r.status} — ${r.violatedRows}/${r.totalRows} violated (${r.pctViolated.toFixed(2)}%, threshold ${check.threshold}%).`)
    } catch (e) {
      out.push(`The check's SQL fails: ${(e as Error).message}`)
    }
    if (!check.exploreSql?.trim()) {
      out.push('This check has no explore SQL; add one with update_dq_check (explore_sql) to list its failing rows.')
      return text(out.join('\n'))
    }
    const n = rows ? (limit ?? 20) : (sample ?? 1000)
    let found: Record<string, unknown>[]
    try {
      found = await query(boundedQuery(check.exploreSql, n))
    } catch (e) {
      return failure(`${out.join('\n')}\nThe explore SQL fails: ${(e as Error).message}`)
    }
    if (!found.length) {
      out.push('The explore SQL returns no row.')
      return text(out.join('\n'))
    }
    if (rows) {
      out.push(`First ${found.length} row(s) of the explore SQL:`, JSON.stringify(found, null, 1).slice(0, 20000))
    } else {
      out.push(`${found.length}${found.length === n ? '+' : ''} row(s) from the explore SQL${found.length === n ? ` (first ${n} read)` : ''} — by column:`,
        ...summarizeRows(found))
    }
    return text(out.join('\n'))
  }))

  server.registerTool('list_dq_runs', {
    description: 'The run history of a data-quality rule set, newest first: date, score, counts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ rule_set_id: string; limit?: number }>({
      type: 'object',
      properties: { ...RULE_SET_ID, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' } },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, limit }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const runs = newestFirst(await dq.listRuns(rs.id))
    if (!runs.length) return text('No run yet. run_dq_rule_set runs it.')
    const n = limit ?? 20
    const lines = runs.slice(0, n).map(runLine)
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
        ...RULE_SET_ID,
        run_id: { type: 'string' },
        statuses: { type: 'array', items: { type: 'string', enum: ['pass', 'fail', 'error', 'not_applicable'] } },
        include_sql: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max checks listed (default 60).' },
      },
      required: ['rule_set_id'],
    }),
  }, guard(async ({ rule_set_id, run_id, statuses, include_sql, limit }) => {
    const rs = await ruleSetOrFail(rule_set_id)
    const runs = newestFirst(await dq.listRuns(rs.id))
    const run = run_id ? runs.find((r) => r.id === run_id) : runs[0]
    if (!run) return failure(run_id ? `No run ${run_id} in this rule set (list_dq_runs lists them).` : 'No run yet.')
    const head = `Run ${run.id} of "${loc(rs.name)}" · ${run.startedAt} · ${run.status}`
    const report = run.report as DqReport | undefined
    if (!report?.results || !report.checks) {
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
        ...RULE_SET_ID,
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
