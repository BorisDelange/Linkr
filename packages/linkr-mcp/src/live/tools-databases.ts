/** A workspace's databases: list, inspect, edit, schema mapping, re-test, create. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { setLocalized } from '@/lib/localized'
import type { DataSource, Project, Workspace } from '@/types'
import { ApiError } from './api.js'
import { describeMapping } from './cohorts.js'
import { clip } from './helpers.js'
import { READ, WRITE, api, failure, guard, text, type Server } from './shared.js'
import {
  BADGES_PROP, LANGUAGE_PROP, countRows, findDatabase, findProject, langOf, linkedProjects, name, resolveWorkspace,
  rest, retestAndStore, statusLine,
} from './workspace-rest.js'
import {
  badgeList, databaseCreateBody, databaseLine, findPreset, kindWords, linkedAfterLink, nameTaken, newAlias,
  presetMappingChange, setBadges, type BadgeInput, type Language, type NewDatabase,
} from './workspace.js'

export function registerDatabaseTools(server: Server): void {
  server.registerTool('list_databases', {
    description:
      'List the databases of your workspaces (the Databases page): status, kind, schema mapping, patient / table '
      + 'counts, and which projects link them. A database is a clinical data source (OMOP, MIMIC…) Linkr queries in place.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string; include_vocabulary_references?: boolean }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Only this workspace\'s. Default: all you can access.' },
        include_vocabulary_references: {
          type: 'boolean', description: 'Also list vocabulary references (OMOP vocabularies used by concept mapping). Default false.',
        },
      },
    }),
  }, guard(async ({ workspace_id, include_vocabulary_references }) => {
    const [databases, projects, workspaces] = await Promise.all([rest.databases(), rest.projects(), rest.workspaces()])
    const shown = databases.filter((d) => (!workspace_id || d.workspaceId === workspace_id)
      && (include_vocabulary_references || !d.isVocabularyReference))
    if (shown.length === 0) return text('No database.')
    const out: string[] = []
    for (const ws of [...workspaces, { id: undefined, name: { en: '(no workspace)' } } as unknown as Workspace]) {
      const inWs = shown.filter((d) => (d.workspaceId ?? undefined) === ws.id)
      if (inWs.length === 0) continue
      out.push(`## ${name(ws.name)}${ws.id ? ` (workspace_id ${ws.id})` : ''}`,
        ...inWs.slice(0, 100).map((d) => databaseLine(d, linkedProjects(projects, d.id))))
      if (inWs.length > 100) out.push(`… ${inWs.length - 100} more: filter by workspace_id`)
    }
    return text(out.join('\n'))
  }))

  server.registerTool('get_database', {
    description:
      'A database\'s details: description, kind and engine, status and error, schema mapping (which preset, local '
      + 'overrides, class relations), statistics when computed, provenance, README, and the projects linking it. '
      + 'Never its location or login.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ database_id: string }>({
      type: 'object', properties: { database_id: { type: 'string' } }, required: ['database_id'],
    }),
  }, guard(async ({ database_id }) => {
    const [db, projects] = await Promise.all([rest.database(database_id), rest.projects()])
    const cache = await rest.statsCache(db.id).catch(() => null)
    const out = [
      `Database "${name(db.name)}" — database_id: ${db.id} · alias ${db.alias} (SQL name ds_${db.alias}) · entity_id ${db.entityId ?? '—'}`,
      `Workspace: ${db.workspaceId ?? '—'} · ${kindWords(db)} · ${statusLine(db)}`,
      `Version ${db.version ?? '0.1.0'}${db.badges?.length ? ` · badges: ${badgeList(db.badges)}` : ''}`
        + ` · created by ${db.createdBy ?? '—'} on ${db.createdAt?.slice(0, 10) ?? '—'}`,
    ]
    if (name(db.description)) out.push(`Description: ${clip(name(db.description), 1500)}`)
    if (db.isVocabularyReference) out.push('Vocabulary reference: used by concept-mapping projects, hidden from the Databases pages.')
    if (db.derivedFrom) {
      out.push(`Derived from cohort "${name(db.derivedFrom.cohort?.name)}" (${db.derivedFrom.level}) of database `
        + `"${name(db.derivedFrom.database?.label)}"`)
    }
    const linked = linkedProjects(projects, db.id)
    out.push(`Linked to: ${linked.length ? linked.join(', ') : 'no project'}`)
    const s = cache?.payload?.summary
    if (s) {
      out.push(`Statistics (computed ${cache!.computedAt.slice(0, 10)}): ${s.patientCount} patients, ${s.visitCount} visits, `
        + `${s.visitDetailCount} unit stays, ${s.tableCount} tables`)
      const tables = cache!.payload.tableCounts ?? []
      if (tables.length) {
        out.push(`Rows per table: ${tables.slice(0, 40).map((t) => `${t.tableName} ${t.rowCount}`).join(', ')}`
          + `${tables.length > 40 ? ` … ${tables.length - 40} more` : ''}`)
      }
    } else if (db.stats?.patientCount != null || db.stats?.visitCount != null) {
      out.push(`Counts: ${db.stats.patientCount ?? '?'} patients, ${db.stats.visitCount ?? '?'} visits`)
    }
    if (db.schemaMapping) {
      const overrides = Object.keys(db.schemaOverrides?.relations ?? {})
      out.push('', `Schema: ${name(db.schemaSource?.label ?? db.schemaMapping.presetLabel) || db.schemaMapping.presetId}`
        + `${db.schemaSource?.version ? ` v${db.schemaSource.version}` : ''}`
        + `${overrides.length ? ` · local overrides: ${overrides.join(', ')}` : ''}`)
      out.push(describeMapping(db.schemaMapping))
    } else {
      out.push('', 'No schema mapping: SQL only (set one with set_database_schema).')
    }
    const readme = name(db.readme)
    if (readme) out.push('', `README:\n${clip(readme, 3000)}`)
    return text(out.join('\n'))
  }))

  server.registerTool('update_database', {
    description:
      'Edit a database\'s name, description, alias, version, badges or README. Changing the alias renames it in SQL '
      + '(ds_<alias>): scripts using the old name break. Its location and logins are not editable here.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      database_id: string; name?: string; description?: string; alias?: string; version?: string
      badges?: BadgeInput[]; readme?: string; language?: Language
    }>({
      type: 'object',
      properties: {
        database_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        alias: { type: 'string', description: 'Lowercase letters, digits, underscores (made so).' },
        version: { type: 'string' },
        badges: BADGES_PROP,
        readme: { type: 'string', description: 'The whole README, Markdown (replaces it in this language).' },
        language: LANGUAGE_PROP,
      },
      required: ['database_id'],
    }),
  }, guard(async (args) => {
    const lang = langOf(args.language)
    const allDatabases = await rest.databases()
    const db = allDatabases.find((d) => d.id === args.database_id)
    if (!db) return failure(`Unknown database_id ${args.database_id}: see list_databases.`)
    const all = allDatabases.filter((d) => d.workspaceId === db.workspaceId)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) {
      if (!args.name.trim()) return failure('The name cannot be empty.')
      if (nameTaken(args.name, all, db.id)) return failure(`Another database of this workspace is already named "${args.name.trim()}".`)
      changes.name = setLocalized(db.name, lang, args.name.trim())
    }
    if (args.description !== undefined) changes.description = setLocalized(db.description, lang, args.description.trim())
    if (args.alias !== undefined) {
      const alias = newAlias(db.alias, args.alias, all.filter((d) => d.id !== db.id))
      if (alias !== db.alias) changes.alias = alias
    }
    if (args.version !== undefined) changes.version = args.version.trim() || '0.1.0'
    if (args.readme !== undefined) changes.readme = setLocalized(db.readme, lang, args.readme)
    if (args.badges) {
      const ws = db.workspaceId ? await rest.workspace(db.workspaceId).catch(() => null) : null
      changes.badges = setBadges(db.badges ?? [], args.badges, ws?.badgeCategories ?? [], lang, randomUUID)
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    const updated = await rest.updateDatabase(db.id, changes)
    return text(`Database "${name(updated.name, lang)}" updated (${Object.keys(changes).join(', ')})`
      + `${changes.alias ? `; its SQL name is now ds_${updated.alias}` : ''}.`)
  }))

  server.registerTool('list_schema_presets', {
    description:
      'The schema presets of a workspace: published data models (OMOP CDM 5.4, MIMIC-IV…) that tell Linkr which '
      + 'table holds patients, stays, measurements. A database takes its schema mapping from one; one with a DDL can '
      + 'also create an empty database (create_database kind empty_from_schema).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string }>({
      type: 'object', properties: { workspace_id: { type: 'string', description: 'Default: your only workspace.' } },
    }),
  }, guard(async ({ workspace_id }) => {
    const ws = await resolveWorkspace(workspace_id)
    if (typeof ws === 'string') return failure(ws)
    const [presets, databases] = await Promise.all([rest.presets(), rest.databases()])
    const mine = presets.filter((p) => p.workspaceId === ws.id)
    if (mine.length === 0) return text(`No schema preset in "${name(ws.name)}": install one from the catalog in Linkr.`)
    return text(mine.map((p) => {
      const users = databases.filter((d) => d.workspaceId === ws.id && (p.lineageId
        ? d.schemaSource?.lineageId === p.lineageId : d.schemaMapping?.presetId === p.presetId)).length
      return `- ${name(p.mapping.presetLabel)} — preset_id: ${p.id ?? p.presetId}${p.entityId ? ` · entity_id ${p.entityId}` : ''}`
        + ` · v${p.version ?? '0.1.0'} · ${p.mapping.ddl ? 'has DDL' : 'no DDL'} · used by ${users} database(s)`
    }).join('\n'))
  }))

  server.registerTool('set_database_schema', {
    description:
      'Give a database the schema mapping of a preset of its workspace (list_schema_presets). The same preset again '
      + 'updates it to the preset\'s current version and keeps the local overrides; another preset replaces the mapping '
      + 'and drops the overrides. Then re-tests the database. Cohorts and concept search follow the new mapping.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ database_id: string; preset_id: string }>({
      type: 'object',
      properties: { database_id: { type: 'string' }, preset_id: { type: 'string' } },
      required: ['database_id', 'preset_id'],
    }),
  }, guard(async ({ database_id, preset_id }) => {
    const db = await findDatabase(database_id)
    if (typeof db === 'string') return failure(db)
    const presets = (await rest.presets()).filter((p) => p.workspaceId === db.workspaceId)
    const preset = findPreset(presets, preset_id)
    if (!preset) return failure(`No preset ${preset_id} in the database's workspace: see list_schema_presets.`)
    const { update, changes } = presetMappingChange(db, preset, presets)
    const updated = await rest.updateDatabase(db.id, changes)
    const { db: tested, loginNeeded } = await retestAndStore(updated)
    return text([
      `"${name(db.name)}" now ${update ? 'follows the current version of' : 'uses'} the schema "${name(preset.mapping.presetLabel)}"`
        + `${update && db.schemaOverrides ? ' (local overrides kept)' : ''}. ${statusLine(tested)}.`,
      ...(loginNeeded ? [loginNeeded] : []),
    ].join('\n'))
  }))

  server.registerTool('retest_database', {
    description:
      'Re-check that a database answers (the app\'s Retest connection) and store its status and table count. Use it '
      + 'on a database in error, or after the user entered their login.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ database_id: string }>({
      type: 'object', properties: { database_id: { type: 'string' } }, required: ['database_id'],
    }),
  }, guard(async ({ database_id }) => {
    const db = await findDatabase(database_id)
    if (typeof db === 'string') return failure(db)
    const { db: tested, loginNeeded } = await retestAndStore(db)
    if (loginNeeded) return failure(loginNeeded)
    return text(`"${name(tested.name)}": ${statusLine(tested)}.`)
  }))

  server.registerTool('create_database', {
    description:
      'Add a database to a workspace. Kinds: "empty_from_schema" creates an empty writable DuckDB with a preset\'s '
      + 'tables (e.g. an OMOP target for an ETL); "server_path" points at data already on the server — a .duckdb / '
      + '.sqlite file or a folder of Parquet files, read in place; "external" declares a PostgreSQL / MySQL server. '
      + 'An external database takes NO password here: each user enters their own login in Linkr. Uploading files '
      + 'from the user\'s computer is done in Linkr itself.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      kind: 'empty_from_schema' | 'server_path' | 'external'; workspace_id?: string; name: string; description?: string
      alias?: string; preset_id?: string; path?: string; engine?: 'duckdb' | 'sqlite' | 'postgresql' | 'mysql'
      host?: string; port?: number; database?: string; schema?: string; allow_writes?: boolean
      require_session_only?: boolean; badges?: BadgeInput[]; version?: string; link_to_project_uid?: string
      language?: Language
    }>({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['empty_from_schema', 'server_path', 'external'] },
        workspace_id: { type: 'string', description: 'Default: your only workspace.' },
        name: { type: 'string' },
        description: { type: 'string' },
        alias: { type: 'string', description: 'Its SQL name (ds_<alias>). Default: from the name.' },
        preset_id: {
          type: 'string',
          description: 'Schema preset (list_schema_presets). Required for empty_from_schema (it must have a DDL); optional otherwise, to map the database.',
        },
        path: {
          type: 'string',
          description: 'Absolute server path. server_path: the file or Parquet folder (inside the folders the server allows). '
            + 'empty_from_schema: a NEW .duckdb to create there instead of Linkr\'s data folder.',
        },
        engine: { type: 'string', enum: ['duckdb', 'sqlite', 'postgresql', 'mysql'], description: 'server_path: duckdb (default, also Parquet) or sqlite. external: postgresql (default) or mysql.' },
        host: { type: 'string', description: 'external.' },
        port: { type: 'number', description: 'external.' },
        database: { type: 'string', description: 'external: the database name on the server.' },
        schema: { type: 'string', description: 'external: the SQL schema holding the tables.' },
        allow_writes: { type: 'boolean', description: 'external PostgreSQL: let Linkr create schemas in it (cohort derivations). Default false.' },
        require_session_only: { type: 'boolean', description: 'external: users\' passwords are kept for their session only, never stored.' },
        badges: BADGES_PROP,
        version: { type: 'string' },
        link_to_project_uid: { type: 'string', description: 'Also link it to this project, as when adding from a project.' },
        language: LANGUAGE_PROP,
      },
      required: ['kind', 'name'],
    }),
  }, guard(async (args) => {
    const lang = langOf(args.language)
    const ws = await resolveWorkspace(args.workspace_id)
    if (typeof ws === 'string') return failure(ws)
    if (!args.name.trim()) return failure('The name is empty.')
    const [allDatabases, presets] = await Promise.all([rest.databases(), rest.presets()])
    // Names and aliases are unique per workspace: the same database installed in
    // two workspaces keeps both (scripts find a database by alias in their own).
    const all = allDatabases.filter((d) => d.workspaceId === ws.id)
    if (nameTaken(args.name, all)) return failure(`A database is already named "${args.name.trim()}" in this workspace.`)
    const wsPresets = presets.filter((p) => p.workspaceId === ws.id)
    const preset = args.preset_id ? findPreset(wsPresets, args.preset_id) : undefined
    if (args.preset_id && !preset) return failure(`No preset ${args.preset_id} in "${name(ws.name)}": see list_schema_presets.`)
    let project: Project | undefined
    if (args.link_to_project_uid) {
      const p = await findProject(args.link_to_project_uid)
      if (typeof p === 'string') return failure(p)
      if (p.workspaceId !== ws.id) return failure('The project to link belongs to another workspace.')
      project = p
    }

    let spec: NewDatabase
    if (args.kind === 'empty_from_schema') {
      if (!preset) return failure('empty_from_schema needs preset_id: a preset with a DDL (list_schema_presets).')
      if (!preset.mapping.ddl) return failure(`The preset "${name(preset.mapping.presetLabel)}" has no DDL: it cannot create tables.`)
      spec = { kind: 'empty-from-schema', preset, path: args.path }
    } else if (args.kind === 'server_path') {
      if (!args.path) return failure('server_path needs path: the absolute server path of the file or Parquet folder.')
      const engine = args.engine ?? 'duckdb'
      if (engine !== 'duckdb' && engine !== 'sqlite') return failure('server_path takes engine duckdb or sqlite.')
      spec = { kind: 'server-path', engine, path: args.path, preset }
    } else {
      const engine = args.engine ?? 'postgresql'
      if (engine !== 'postgresql' && engine !== 'mysql') return failure('external takes engine postgresql or mysql.')
      if (!args.host || !args.database) return failure('external needs host and database.')
      spec = {
        kind: 'external', engine, host: args.host, port: args.port, database: args.database, schema: args.schema,
        allowWrites: args.allow_writes, requireSessionOnly: args.require_session_only, preset,
      }
    }

    const body = databaseCreateBody({
      id: randomUUID(), lineageId: randomUUID(), workspaceId: ws.id, name: args.name.trim(),
      description: args.description, alias: newAlias(args.name, args.alias, all), version: args.version, lang, spec,
      badges: setBadges([], args.badges ?? [], ws.badgeCategories ?? [], lang, randomUUID),
    })
    let created: DataSource
    try {
      created = await rest.createDatabase(body)
    } catch (e) {
      if (spec.kind === 'server-path' && e instanceof ApiError && e.status === 400) {
        return failure(`The server refused the path "${spec.path}" (${e.message}): it must exist and lie inside the folders the server allows (ask the user, or pick it in Linkr's file picker).`)
      }
      throw e
    }

    let db: DataSource = created
    let loginNeeded: string | undefined
    if (spec.kind === 'empty-from-schema') {
      try {
        db = await rest.createFromDdl(created.id, spec.preset.mapping.ddl!, spec.path)
        const tables = (await api.getSchema(db.id)).length
        db = await rest.updateDatabase(db.id, {
          status: 'connected', errorMessage: null, stats: { tableCount: tables, ...(await countRows(db)) },
        })
      } catch (e) {
        // As the app: a file asked for in a server folder is not silently made elsewhere by a later rebuild.
        if (spec.path) {
          await rest.deleteDatabase(created.id).catch(() => {})
          throw e
        }
        db = await rest.updateDatabase(created.id, { status: 'error', errorMessage: (e as Error).message })
      }
    } else if (spec.kind === 'server-path') {
      try {
        db = await rest.updateDatabase(db.id, {
          status: 'connected', errorMessage: null, stats: { tableCount: (await api.getSchema(db.id)).length },
        })
      } catch (e) {
        db = await rest.updateDatabase(db.id, { status: 'error', errorMessage: (e as Error).message })
      }
    } else {
      const r = await retestAndStore(db)
      db = r.db
      loginNeeded = r.loginNeeded
      if (loginNeeded) {
        db = await rest.updateDatabase(db.id, {
          status: 'error', errorMessage: 'No login entered yet: use Retest connection to enter your own account.',
        })
      }
    }
    if (project) {
      const changes = linkedAfterLink(project, [...all, db], db.id)
      if (changes) await rest.updateProject(project.uid, changes)
    }
    return text([
      `Database "${name(db.name, lang)}" created in "${name(ws.name)}" — database_id: ${db.id} · alias ${db.alias} · ${statusLine(db)}.`,
      ...(project ? [`Linked to project "${name(project.name)}".`] : []),
      ...(loginNeeded
        ? ['Nobody has a login to it yet. Ask the user to open this database in Linkr and use "Retest connection": '
          + 'Linkr asks for their own account there. Never ask for the password in this conversation. Then call retest_database.']
        : []),
      ...(!db.schemaMapping ? ['No schema mapping: set one with set_database_schema for cohorts and concept search.'] : []),
    ].join('\n'))
  }))
}

