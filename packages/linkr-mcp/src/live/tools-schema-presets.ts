/** A schema preset read and edited relation by relation, and a relation tried on a database before it is saved. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { setLocalized } from '@/lib/localized'
import { checkContract, type DescribedColumn } from '@/lib/schema-classes/contract-check'
import { withClassRelations } from '@/lib/schema-classes/inject'
import { classRelations, generatedRelationSql } from '@/lib/schema-classes/relations'
import { specAt, withSpec } from '@/lib/schema-classes/spec'
import { sanitizeSchemaMapping } from '@/lib/schema-helpers'
import type { CustomSchemaPreset, DataSource } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import { formatRows } from './cohorts.js'
import {
  applyPresetParts, buildRelationSpec, parseRelationKey, presetText, putRelation, relationProblems, relationText,
  type PresetPartsInput, type RelationInput, type RelationKey,
} from './presets.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, text, type Server } from './shared.js'
import { LANGUAGE_PROP, findDatabase, langOf, name, rest } from './workspace-rest.js'
import { findPreset, type Language } from './workspace.js'

const enc = encodeURIComponent

const RELATION_PROP = {
  type: 'string',
  description: 'patient, visit, visitDetail, note, concepts.<key>, events.<label> or drugs.<label> (as get_schema_preset lists them).',
} as const

/** The relation properties a tool call may set; each one given replaces the stored one, `clear` removes some. */
const SPEC_PROPS = {
  from: {
    type: 'object',
    description: 'Grain table of a visual relation: {schema?, table, alias}. One row of the class per row of it.',
  },
  joins: {
    type: 'array',
    description: 'Visual joins: [{schema?, table, alias, type: "left"|"inner", on: [["a.col", "b.col"], …]}].',
  },
  where: { type: 'string', description: 'SQL filter over the aliases (visual relation).' },
  fields: {
    type: 'object',
    description: 'Contract column → "alias.column", {"expr": "SQL over the aliases"} or {"value": constant}. Replaces all fields.',
  },
  custom_sql: {
    type: 'string',
    description: 'One SELECT (DuckDB) returning contract columns by name; replaces the visual form while set. Tables as in describe_database. Clear it to go back to the visual form.',
  },
  sql_columns: {
    type: 'array', items: { type: 'string' },
    description: 'Contract columns the custom SQL fills. Normally measured for you: pass check_database_id instead.',
  },
  drug_kind: { type: 'string', enum: ['administration', 'prescription'], description: 'Drug relations only.' },
  concept_dictionary_key: {
    type: 'string',
    description: 'Event / drug: the concepts.<key> its concept_id points into ("none": concepts named inline). Default: the first dictionary.',
  },
  gender_values: { type: 'object', description: 'Patient only: raw values {male, female, unknown?}.' },
  clear: {
    type: 'array',
    items: { type: 'string', enum: ['from', 'joins', 'where', 'fields', 'custom_sql', 'sql_columns', 'drug_kind', 'concept_dictionary_key', 'gender_values'] },
    description: 'Properties to remove from the stored relation (e.g. ["where"], or ["custom_sql"] to go back to the visual form).',
  },
} as const

type SpecArgs = RelationInput & { relation: string; clear?: (keyof RelationInput)[] }

const specInput = (a: SpecArgs): RelationInput => {
  const input: RelationInput = {
    from: a.from, joins: a.joins, where: a.where, fields: a.fields, custom_sql: a.custom_sql, sql_columns: a.sql_columns,
    drug_kind: a.drug_kind, concept_dictionary_key: a.concept_dictionary_key, gender_values: a.gender_values,
  }
  for (const k of a.clear ?? []) if (k in input) input[k] = null
  return input
}

async function workspacePreset(key: string): Promise<CustomSchemaPreset | string> {
  const preset = findPreset(await rest.presets(), key)
  return preset ?? `No schema preset ${key}: see list_schema_presets.`
}

/** The databases whose mapping came from this preset — they hold a copy, refreshed by set_database_schema. */
async function presetUsers(preset: CustomSchemaPreset): Promise<DataSource[]> {
  return (await rest.databases()).filter((d) => d.workspaceId === preset.workspaceId && (preset.lineageId
    ? d.schemaSource?.lineageId === preset.lineageId : d.schemaMapping?.presetId === preset.presetId))
}

async function savePreset(preset: CustomSchemaPreset, changes: Partial<CustomSchemaPreset>): Promise<string> {
  const next = { ...preset, ...changes, updatedAt: new Date().toISOString() }
  next.mapping = sanitizeSchemaMapping(next.mapping)
  await api.request('PUT', `/schema-presets/${enc(preset.id ?? preset.presetId)}`, next)
  const users = await presetUsers(preset)
  return users.length
    ? `Databases using it keep their copy until updated: set_database_schema on ${users.map((d) => `"${name(d.name)}" (${d.id})`).join(', ')} with this preset.`
    : 'No database uses it yet.'
}

/** What the relation's own SQL returns, before the contract projection pads it — what the app's SQL dialog checks. */
function bodySql(mapping: SchemaMapping, rk: RelationKey): string | null {
  const custom = specAt(mapping, rk.key)?.customSql?.trim()
  return custom ? custom.replace(/;\s*$/, '') : generatedRelationSql(mapping, rk.key)
}

async function contractOn(databaseId: string, mapping: SchemaMapping, rk: RelationKey) {
  const body = bodySql(mapping, rk)
  if (!body) throw new Error(`Nothing to check: ${rk.key} has neither SQL nor a visual form.`)
  const described = await api.query(databaseId, `DESCRIBE ${body}`, { pushdown: false }) as unknown as DescribedColumn[]
  return checkContract(rk.cls, described, body)
}

function contractLines(r: ReturnType<typeof checkContract>): string[] {
  return [
    `Contract: fills ${r.filled.join(', ') || 'nothing'}.`,
    ...(r.missingRequired.length ? [`✗ Required columns missing: ${r.missingRequired.join(', ')}.`] : []),
    ...r.typeMismatches.map((m) => `✗ ${m.column} is ${m.type}, the contract wants ${m.expected}.`),
    ...(r.unknown.length ? [`Ignored (not in the contract): ${r.unknown.join(', ')}.`] : []),
    ...(r.globalWindow ? ['⚠ A window over the whole relation (OVER without PARTITION BY) stops per-patient filters from being pushed into it.'] : []),
  ]
}

/** The mapping with the relation edited, or why it cannot be. */
function editedMapping(base: SchemaMapping, args: SpecArgs): { mapping: SchemaMapping; rk: RelationKey; isNew: boolean } | string {
  const rk = parseRelationKey(args.relation)
  if (typeof rk === 'string') return rk
  const current = specAt(base, rk.key)
  const spec = buildRelationSpec(rk, specInput(args), current)
  const mapping = putRelation(base, rk, spec)
  const problems = relationProblems(mapping, rk)
  if (problems.length) return `${rk.key} cannot be ${current ? 'saved' : 'added'} as given:\n${problems.map((p) => `- ${p}`).join('\n')}`
  return { mapping, rk, isNew: !current }
}

export function registerSchemaPresetTools(server: Server): void {
  server.registerTool('get_schema_preset', {
    description:
      'A schema preset\'s mapping: how Linkr reads the source — one relation per class (patient, visit, visitDetail, '
      + 'note, concept dictionaries, events, drugs), each a visual form (from, joins, where, fields) or custom SQL — '
      + 'plus its DDL tables. With `relation`, that relation in full (SQL, fields, the JSON to edit it from); with '
      + '`ddl`, the DDL itself. A database holds a copy of its preset\'s mapping, plus its own overrides (get_database).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ preset_id: string; relation?: string; ddl?: boolean }>({
      type: 'object',
      properties: {
        preset_id: { type: 'string', description: 'Id or entity id (list_schema_presets).' },
        relation: RELATION_PROP,
        ddl: { type: 'boolean', description: 'Return the DDL (CREATE TABLE statements).' },
      },
      required: ['preset_id'],
    }),
  }, guard(async ({ preset_id, relation, ddl }) => {
    const preset = await workspacePreset(preset_id)
    if (typeof preset === 'string') return failure(preset)
    const m = preset.mapping
    if (ddl) return text(m.ddl?.trim() ? m.ddl : 'This preset has no DDL.')
    if (relation) {
      const rk = parseRelationKey(relation)
      if (typeof rk === 'string') return failure(rk)
      const spec = specAt(m, rk.key)
      if (!spec) return failure(`No relation ${rk.key} in "${name(m.presetLabel)}".`)
      const rel = classRelations(sanitizeSchemaMapping(m)).find((r) => r.specKey === rk.key)
      return text([
        relationText(rk.cls, rk.key, spec, true),
        ...(rel ? [`Queried as ${rel.name}; columns carrying data: ${[...rel.mapped].join(', ')}.`] : []),
        ...(rel?.problems.length ? [`Problems: ${rel.problems.join('; ')}`] : []),
        'JSON:', JSON.stringify(spec, null, 2),
      ].join('\n'))
    }
    const users = await presetUsers(preset)
    return text([
      `"${name(m.presetLabel)}" — preset_id ${preset.id ?? preset.presetId}${preset.entityId ? ` · entity_id ${preset.entityId}` : ''}`
        + ` · v${preset.version ?? '0.1.0'}${preset.gitRemoteConfig ? ' · git-linked' : ''}`
        + ` · used by ${users.length ? users.map((d) => `"${name(d.name)}"`).join(', ') : 'no database'}`,
      ...(m.description ? [name(m.description)] : []),
      '',
      presetText(m),
    ].join('\n'))
  }))

  server.registerTool('preview_schema_relation', {
    description:
      'Try a relation on a database WITHOUT saving it: the relation as stored, or with the changes given (same '
      + 'properties as set_schema_relation) laid over it. Returns the contract check (which class columns it fills, '
      + 'required ones missing, wrong types), the row count and sample rows. Reads the database\'s own mapping, or a '
      + 'preset\'s with preset_id. A relation reading a table the database lacks reads empty, as in the app.',
    annotations: READ,
    inputSchema: fromJsonSchema<SpecArgs & { database_id: string; preset_id?: string; max_rows?: number }>({
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        preset_id: { type: 'string', description: 'Start from this preset\'s mapping instead of the database\'s.' },
        relation: RELATION_PROP,
        ...SPEC_PROPS,
        max_rows: { type: 'number', description: 'Sample rows shown, default 10, max 100.' },
      },
      required: ['database_id', 'relation'],
    }),
  }, guard(async (args) => {
    const db = await findDatabase(args.database_id)
    if (typeof db === 'string') return failure(db)
    let base: SchemaMapping | null | undefined
    if (args.preset_id) {
      const preset = await workspacePreset(args.preset_id)
      if (typeof preset === 'string') return failure(preset)
      base = preset.mapping
    } else {
      base = (await api.getDataSource(db.id)).schemaMapping
    }
    if (!base) return failure(`"${name(db.name)}" has no schema mapping: pass preset_id, or set one with set_database_schema.`)
    const edited = editedMapping(sanitizeSchemaMapping(base), args)
    if (typeof edited === 'string') return failure(edited)
    const { rk } = edited
    let { mapping } = edited
    const tables = (await api.getSchema(db.id)).map((t) => t.name)
    const lines: string[] = []
    try {
      const report = await contractOn(db.id, mapping, rk)
      lines.push(...contractLines(report))
      // Run it as set_schema_relation would store it: the measured columns are what
      // makes, say, a (terminology, code) concept key resolve against the dictionary.
      const spec = specAt(mapping, rk.key)!
      if (spec.customSql?.trim() && args.sql_columns == null) mapping = putRelation(mapping, rk, { ...spec, sqlColumns: report.filled })
    } catch (e) {
      lines.push(`✗ Contract check failed: ${(e as Error).message}`)
    }
    const rel = classRelations(mapping).find((r) => r.specKey === rk.key)!
    lines.unshift(`${rk.key} on "${name(db.name)}" — queried as ${rel.name}.`)
    const run = (sql: string) => api.query(db.id, withClassRelations(sql, mapping, tables), { pushdown: false })
    try {
      const [{ n }] = await run(`SELECT count(*) AS n FROM ${rel.name}`) as { n: number }[]
      lines.push(`Rows: ${n}.`)
      const rows = await run(`SELECT * FROM ${rel.name} LIMIT ${Math.min(Math.max(args.max_rows ?? 10, 1), 100)}`)
      lines.push(formatRows(rows, rows.length))
    } catch (e) {
      lines.push(`✗ The relation does not run: ${(e as Error).message}`)
    }
    return text(lines.join('\n'))
  }))

  server.registerTool('set_schema_relation', {
    description:
      'Add or change one relation of a schema preset (the Mapping editor of a preset). Properties given replace the '
      + 'stored ones, `clear` removes some, the rest is kept — so `where` alone adds a filter. A relation that does not '
      + 'compile is refused. Custom SQL needs check_database_id (or sql_columns): the contract check measures which '
      + 'columns it fills, as the app\'s SQL dialog does. Try it first with preview_schema_relation. Databases keep '
      + 'their copy of the mapping until set_database_schema updates them.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<SpecArgs & { preset_id: string; check_database_id?: string }>({
      type: 'object',
      properties: {
        preset_id: { type: 'string', description: 'Id or entity id (list_schema_presets).' },
        relation: RELATION_PROP,
        ...SPEC_PROPS,
        check_database_id: { type: 'string', description: 'A database to run the contract check of custom SQL on.' },
      },
      required: ['preset_id', 'relation'],
    }),
  }, guard(async (args) => {
    const preset = await workspacePreset(args.preset_id)
    if (typeof preset === 'string') return failure(preset)
    const edited = editedMapping(sanitizeSchemaMapping(preset.mapping), args)
    if (typeof edited === 'string') return failure(edited)
    let { mapping } = edited
    const { rk, isNew } = edited
    const spec = specAt(mapping, rk.key)!
    const notes: string[] = []
    if (spec.customSql?.trim() && args.check_database_id) {
      const db = await findDatabase(args.check_database_id)
      if (typeof db === 'string') return failure(db)
      const report = await contractOn(db.id, mapping, rk)
      if (report.missingRequired.length || report.typeMismatches.length) {
        return failure([`${rk.key} not saved: its SQL does not honour the ${rk.cls} contract on "${name(db.name)}".`, ...contractLines(report)].join('\n'))
      }
      if (args.sql_columns == null) mapping = putRelation(mapping, rk, { ...spec, sqlColumns: report.filled })
      notes.push(...contractLines(report))
    } else if (spec.customSql?.trim() && !spec.sqlColumns?.length) {
      return failure('Custom SQL needs check_database_id (to measure the columns it fills) or sql_columns.')
    }
    const after = await savePreset(preset, { mapping })
    return text([`${rk.key} ${isNew ? 'added to' : 'saved in'} "${name(preset.mapping.presetLabel)}".`, ...notes, after].join('\n'))
  }))

  server.registerTool('remove_schema_relation', {
    description:
      'Remove one relation from a schema preset (an event or drug relation, a concept dictionary, or a singleton '
      + 'class such as note). Cohorts or widgets naming an event / drug label then find nothing under it.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ preset_id: string; relation: string }>({
      type: 'object',
      properties: { preset_id: { type: 'string' }, relation: RELATION_PROP },
      required: ['preset_id', 'relation'],
    }),
  }, guard(async ({ preset_id, relation }) => {
    const preset = await workspacePreset(preset_id)
    if (typeof preset === 'string') return failure(preset)
    const rk = parseRelationKey(relation)
    if (typeof rk === 'string') return failure(rk)
    const m = sanitizeSchemaMapping(preset.mapping)
    if (!specAt(m, rk.key)) return failure(`No relation ${rk.key} in "${name(m.presetLabel)}".`)
    const after = await savePreset(preset, { mapping: withSpec(m, rk.key, undefined) })
    return text(`${rk.key} removed from "${name(m.presetLabel)}".\n${after}`)
  }))

  server.registerTool('update_schema_preset', {
    description:
      'Edit a schema preset\'s other parts: name, description, README, version, its DDL (the CREATE TABLE statements '
      + 'the editor and "create empty database" use), known tables (table names recognised in a Parquet folder) and '
      + 'ERD groups. Relations are edited with set_schema_relation.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<PresetPartsInput & {
      preset_id: string; name?: string; description?: string; readme?: string; version?: string; language?: Language
    }>({
      type: 'object',
      properties: {
        preset_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        readme: { type: 'string', description: 'The whole README, Markdown (replaces it in this language).' },
        version: { type: 'string', description: 'Semver. Change it only when the user asks.' },
        ddl: { type: 'string', description: 'The whole DDL (replaces it; empty removes it). Read it first with get_schema_preset ddl.' },
        known_tables_add: { type: 'array', items: { type: 'string' } },
        known_tables_remove: { type: 'array', items: { type: 'string' } },
        erd_groups: {
          type: 'array', items: { type: 'object' },
          description: 'All ERD groups (replaces them): [{id, label, color, tables: [...]}].',
        },
        language: LANGUAGE_PROP,
      },
      required: ['preset_id'],
    }),
  }, guard(async (args) => {
    const preset = await workspacePreset(args.preset_id)
    if (typeof preset === 'string') return failure(preset)
    const lang = langOf(args.language)
    let mapping = applyPresetParts(preset.mapping, args)
    const changes: Partial<CustomSchemaPreset> = {}
    const changed: string[] = []
    if (args.name !== undefined) {
      if (!args.name.trim()) return failure('The name cannot be empty.')
      mapping = { ...mapping, presetLabel: setLocalized(mapping.presetLabel, lang, args.name.trim()) }
      changed.push('name')
    }
    if (args.description !== undefined) {
      mapping = { ...mapping, description: setLocalized(mapping.description, lang, args.description.trim()) }
      changed.push('description')
    }
    if (args.readme !== undefined) {
      changes.readme = setLocalized(preset.readme, lang, args.readme)
      changed.push('README')
    }
    if (args.version !== undefined) {
      changes.version = args.version.trim() || '0.1.0'
      changed.push('version')
    }
    if (args.ddl !== undefined) changed.push('DDL')
    if (args.known_tables_add?.length || args.known_tables_remove?.length) changed.push('known tables')
    if (args.erd_groups !== undefined) changed.push('ERD groups')
    if (changed.length === 0) return failure('Nothing to change.')
    const after = await savePreset(preset, { ...changes, mapping })
    return text(`"${name(mapping.presetLabel, lang)}" updated (${changed.join(', ')}).\n${after}`)
  }))
}
