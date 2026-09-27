/** Workspaces and projects: create, edit, link databases. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { setLocalized } from '@/lib/localized'
import type { ProjectStatus } from '@/types'
import { DESTRUCTIVE, READ, WRITE, failure, guard, text, type Server } from './shared.js'
import { registerDatabaseTools } from './tools-databases.js'
import {
  BADGES_PROP, LANGUAGE_PROP, findProject, langOf, linkedProjects, name, resolveWorkspace, rest,
} from './workspace-rest.js'
import {
  PROJECT_STATUSES, applyTodoChanges, badgeList, databaseLine, linkRefusal, linkedAfterLink, linkedAfterUnlink, projectCreateBody,
  projectEntityId, projectLines, setBadges, truncate, workspaceCreateBody, workspaceLine, type BadgeInput, type Language,
} from './workspace.js'

export function registerWorkspaceTools(server: Server): void {
  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  server.registerTool('list_workspaces', {
    description:
      'List the Linkr workspaces you can access. A workspace is a team\'s space: it holds projects (studies), '
      + 'databases, schema presets, concept-mapping projects and a wiki. Gives the workspace_id other tools take.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => {
    const [workspaces, projects, databases] = await Promise.all([rest.workspaces(), rest.projects(), rest.databases()])
    if (workspaces.length === 0) return text('No workspace accessible.')
    return text(workspaces.map((w) => workspaceLine(w,
      projects.filter((p) => p.workspaceId === w.id).length,
      databases.filter((d) => d.workspaceId === w.id && !d.isVocabularyReference).length)).join('\n'))
  }))

  server.registerTool('get_workspace', {
    description:
      'A workspace\'s home page: description, organization, badges, README, and what it holds — its projects, '
      + 'databases, schema presets, concept-mapping projects and wiki pages (counts and lists).',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id: string }>({
      type: 'object', properties: { workspace_id: { type: 'string' } }, required: ['workspace_id'],
    }),
  }, guard(async ({ workspace_id }) => {
    const ws = await rest.workspace(workspace_id)
    const [projects, databases, presets, mapping, wiki, orgs] = await Promise.all([
      rest.projects(), rest.databases(), rest.presets(),
      rest.mappingProjects(workspace_id).catch(() => null),
      rest.wikiPages(workspace_id).catch(() => null),
      rest.organizations().catch(() => []),
    ])
    const wsProjects = projects.filter((p) => p.workspaceId === ws.id)
    const wsDatabases = databases.filter((d) => d.workspaceId === ws.id && !d.isVocabularyReference)
    const wsPresets = presets.filter((p) => p.workspaceId === ws.id)
    const org = orgs.find((o) => o.id === ws.organizationId)
    const out = [
      `Workspace "${name(ws.name)}" — workspace_id: ${ws.id}`,
      `Organization: ${org ? `${name(org.name)} (${org.id})` : ws.organizationId ?? 'none'}`
        + ` · created by ${ws.createdBy ?? '—'} on ${ws.createdAt?.slice(0, 10) ?? '—'}`,
    ]
    if (name(ws.description)) out.push(`Description: ${truncate(name(ws.description), 1500)}`)
    if (ws.badges?.length) out.push(`Badges: ${badgeList(ws.badges)}`)
    if (ws.badgeCategories?.length) {
      out.push(`Badge categories: ${ws.badgeCategories.map((c) => `${name(c.name)}${c.exclusive ? ' (one value)' : ''}`).join(', ')}`)
    }
    out.push(`Counts: ${wsProjects.length} project(s), ${wsDatabases.length} database(s), ${wsPresets.length} schema preset(s), `
      + `${mapping ? mapping.length : '?'} mapping project(s), ${wiki ? wiki.length : '?'} wiki page(s)`)
    out.push('', 'Projects:', ...wsProjects.slice(0, 50).map((p) =>
      `- ${name(p.name)} — project_uid: ${p.uid} · ${p.status ?? 'active'} · ${(p.linkedDataSourceIds ?? []).length} database(s)`))
    if (wsProjects.length > 50) out.push(`… ${wsProjects.length - 50} more (list_projects)`)
    out.push('', 'Databases:', ...wsDatabases.slice(0, 50).map((d) => databaseLine(d, linkedProjects(projects, d.id))))
    if (wsDatabases.length > 50) out.push(`… ${wsDatabases.length - 50} more (list_databases)`)
    if (mapping?.length) {
      out.push('', 'Mapping projects:', ...mapping.slice(0, 20).map((m) => `- ${name(m.name)} — ${m.id}`))
    }
    const readme = name(ws.readme)
    out.push('', readme ? `README:\n${truncate(readme, 3000)}` : 'README: empty')
    return text(out.join('\n'))
  }))

  server.registerTool('create_workspace', {
    description:
      'Create a workspace (needs the global right to create workspaces). You become its owner. Its built-in '
      + 'plugins are added when someone first opens its Plugins page in Linkr.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      name: string; description?: string; organization_id?: string; badges?: BadgeInput[]; language?: Language
    }>({
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        organization_id: { type: 'string', description: 'The organization it belongs to (list_organizations).' },
        badges: BADGES_PROP,
        language: LANGUAGE_PROP,
      },
      required: ['name'],
    }),
  }, guard(async (args) => {
    if (!args.name.trim()) return failure('The name is empty.')
    const lang = langOf(args.language)
    if (args.organization_id) {
      const orgs = await rest.organizations()
      if (!orgs.some((o) => o.id === args.organization_id)) return failure(`Unknown organization_id: see list_organizations.`)
    }
    const ws = await rest.createWorkspace(workspaceCreateBody({
      id: randomUUID(), lineageId: randomUUID(), name: args.name.trim(), description: args.description?.trim(),
      organizationId: args.organization_id, badges: setBadges([], args.badges ?? [], [], lang, randomUUID), lang,
    }))
    return text(`Workspace "${name(ws.name, lang)}" created — workspace_id: ${ws.id}.`)
  }))

  server.registerTool('update_workspace', {
    description:
      'Edit a workspace\'s name, description, README (Markdown), organization or badges. Only the fields given change.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      workspace_id: string; name?: string; description?: string; readme?: string; organization_id?: string
      badges?: BadgeInput[]; language?: Language
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        readme: { type: 'string', description: 'The whole README, Markdown (replaces it in this language).' },
        organization_id: { type: 'string', description: 'list_organizations; "" removes it.' },
        badges: BADGES_PROP,
        language: LANGUAGE_PROP,
      },
      required: ['workspace_id'],
    }),
  }, guard(async (args) => {
    const lang = langOf(args.language)
    const ws = await rest.workspace(args.workspace_id)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) {
      if (!args.name.trim()) return failure('The name cannot be empty.')
      changes.name = setLocalized(ws.name, lang, args.name.trim())
    }
    if (args.description !== undefined) changes.description = setLocalized(ws.description, lang, args.description.trim())
    if (args.readme !== undefined) changes.readme = setLocalized(ws.readme, lang, args.readme)
    if (args.organization_id !== undefined) {
      if (args.organization_id && !(await rest.organizations()).some((o) => o.id === args.organization_id)) {
        return failure('Unknown organization_id: see list_organizations.')
      }
      changes.organizationId = args.organization_id || null
    }
    if (args.badges) changes.badges = setBadges(ws.badges ?? [], args.badges, ws.badgeCategories ?? [], lang, randomUUID)
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    const updated = await rest.updateWorkspace(ws.id, changes)
    return text(`Workspace "${name(updated.name, lang)}" updated (${Object.keys(changes).join(', ')}).`)
  }))

  server.registerTool('list_organizations', {
    description: 'The organizations (hospitals, labs…) known to this Linkr instance, which a workspace can belong to.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => {
    const orgs = await rest.organizations()
    if (orgs.length === 0) return text('No organization declared.')
    return text(orgs.map((o) => `- ${name(o.name)} — organization_id: ${o.id}${o.type ? ` · ${o.type}` : ''}`).join('\n'))
  }))

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  server.registerTool('create_project', {
    description:
      'Create a project (a study) in a workspace, as Linkr\'s New project dialog does. It starts with no database: '
      + 'link one with link_database_to_project. entity_id is its permanent readable identifier (folder name in '
      + 'exports and git); omitted, it is derived from the name.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      workspace_id?: string; name: string; description?: string; entity_id?: string; status?: ProjectStatus
      badges?: BadgeInput[]; version?: string; language?: Language
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Default: your only workspace.' },
        name: { type: 'string' },
        description: { type: 'string' },
        entity_id: { type: 'string', description: 'Lowercase letters, digits, hyphens; 2–50 characters; unique in the workspace.' },
        status: { type: 'string', enum: PROJECT_STATUSES, description: 'Default active.' },
        badges: BADGES_PROP,
        version: { type: 'string', description: 'Default 0.1.0.' },
        language: LANGUAGE_PROP,
      },
      required: ['name'],
    }),
  }, guard(async (args) => {
    const ws = await resolveWorkspace(args.workspace_id)
    if (typeof ws === 'string') return failure(ws)
    if (!args.name.trim()) return failure('The name is empty.')
    const lang = langOf(args.language)
    const taken = (await rest.projects()).filter((p) => p.workspaceId === ws.id)
      .map((p) => p.entityId ?? p.projectId).filter((id): id is string => !!id)
    const entity = projectEntityId(args.name.trim(), args.entity_id, taken)
    if ('error' in entity) return failure(entity.error)
    const project = await rest.createProject(projectCreateBody({
      uid: randomUUID(), lineageId: randomUUID(), workspaceId: ws.id, entityId: entity.id, name: args.name.trim(),
      description: args.description?.trim(), status: args.status, version: args.version, lang,
      badges: setBadges([], args.badges ?? [], ws.badgeCategories ?? [], lang, randomUUID),
    }))
    return text(`Project "${name(project.name, lang)}" created in "${name(ws.name)}" — project_uid: ${project.uid} · entity_id: ${entity.id}.`)
  }))

  server.registerTool('get_project_summary', {
    description:
      'A project\'s Summary page: status, version, badges, author, descriptions, linked databases, its task list '
      + '(with task ids), notes and README. get_project_context gives the databases\' schema and cohorts instead.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const [project, databases] = await Promise.all([rest.project(project_uid), rest.databases()])
    return text(projectLines(project, databases).join('\n'))
  }))

  server.registerTool('update_project', {
    description:
      'Edit a project: name, description, short description, status, version, badges, README (Markdown), notes, and '
      + 'its task (to-do) list: add, complete, reopen, rename, remove by task id from get_project_summary. Only what is given changes.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      project_uid: string; name?: string; description?: string; short_description?: string; status?: ProjectStatus
      version?: string; badges?: BadgeInput[]; readme?: string; notes?: string; add_tasks?: string[]
      complete_tasks?: string[]; reopen_tasks?: string[]; remove_tasks?: string[]
      rename_tasks?: { id: string; text: string }[]; language?: Language
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        short_description: { type: 'string', description: 'One line, shown on project cards.' },
        status: { type: 'string', enum: PROJECT_STATUSES },
        version: { type: 'string', description: 'Semver, e.g. 1.2.0.' },
        badges: BADGES_PROP,
        readme: { type: 'string', description: 'The whole README, Markdown (replaces it in this language).' },
        notes: { type: 'string', description: 'The whole notes text (replaces it in this language).' },
        add_tasks: { type: 'array', items: { type: 'string' } },
        complete_tasks: { type: 'array', items: { type: 'string' }, description: 'Task ids.' },
        reopen_tasks: { type: 'array', items: { type: 'string' }, description: 'Task ids.' },
        remove_tasks: { type: 'array', items: { type: 'string' }, description: 'Task ids.' },
        rename_tasks: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
        },
        language: LANGUAGE_PROP,
      },
      required: ['project_uid'],
    }),
  }, guard(async (args) => {
    const lang = langOf(args.language)
    const project = await rest.project(args.project_uid)
    const changes: Record<string, unknown> = {}
    if (args.name !== undefined) {
      if (!args.name.trim()) return failure('The name cannot be empty.')
      changes.name = setLocalized(project.name, lang, args.name.trim())
    }
    if (args.description !== undefined) changes.description = setLocalized(project.description, lang, args.description.trim())
    if (args.short_description !== undefined) {
      changes.shortDescription = setLocalized(project.shortDescription, lang, args.short_description.trim())
    }
    if (args.status !== undefined) changes.status = args.status
    if (args.version !== undefined) changes.version = args.version.trim() || '0.1.0'
    if (args.readme !== undefined) changes.readme = setLocalized(project.readme, lang, args.readme)
    if (args.notes !== undefined) changes.notes = setLocalized(project.notes, lang, args.notes)
    if (args.badges) {
      const ws = project.workspaceId ? await rest.workspace(project.workspaceId).catch(() => null) : null
      changes.badges = setBadges(project.badges ?? [], args.badges, ws?.badgeCategories ?? [], lang, randomUUID)
    }
    const taskArgs = [args.add_tasks, args.complete_tasks, args.reopen_tasks, args.remove_tasks, args.rename_tasks]
    if (taskArgs.some((a) => a?.length)) {
      const next = applyTodoChanges(project.todos ?? [], {
        add: args.add_tasks, done: args.complete_tasks, undone: args.reopen_tasks,
        remove: args.remove_tasks, rename: args.rename_tasks,
      }, lang, Date.now())
      if ('error' in next) return failure(next.error)
      changes.todos = next.todos
    }
    if (Object.keys(changes).length === 0) return failure('Nothing to change.')
    const updated = await rest.updateProject(project.uid, changes)
    return text(`Project "${name(updated.name, lang)}" updated (${Object.keys(changes).join(', ')}).`)
  }))

  server.registerTool('link_database_to_project', {
    description:
      'Link a workspace database to a project, so the project\'s cohorts, concepts, SQL and patient data can use it '
      + '(the project\'s Databases page, "Link a database").',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; database_id: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, database_id: { type: 'string' } },
      required: ['project_uid', 'database_id'],
    }),
  }, guard(async ({ project_uid, database_id }) => {
    const [project, databases] = await Promise.all([findProject(project_uid), rest.databases()])
    if (typeof project === 'string') return failure(project)
    const db = databases.find((d) => d.id === database_id)
    if (!db) return failure(`Unknown database_id ${database_id}: see list_databases.`)
    const refusal = linkRefusal(project, db)
    if (refusal) return failure(`Cannot link "${name(db.name)}": ${refusal}.`)
    const changes = linkedAfterLink(project, databases, database_id)
    if (!changes) return text(`"${name(db.name)}" is already linked to "${name(project.name)}".`)
    await rest.updateProject(project.uid, changes)
    return text(`"${name(db.name)}" linked to project "${name(project.name)}" (${changes.linkedDataSourceIds.length} database(s) now).`)
  }))

  server.registerTool('unlink_database_from_project', {
    description:
      'Remove a database from a project\'s linked databases. The database itself and its data are untouched; '
      + 'the project\'s cohorts and datasets stay but can no longer query it.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; database_id: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, database_id: { type: 'string' } },
      required: ['project_uid', 'database_id'],
    }),
  }, guard(async ({ project_uid, database_id }) => {
    const project = await findProject(project_uid)
    if (typeof project === 'string') return failure(project)
    const changes = linkedAfterUnlink(project, database_id)
    if (!changes) return failure(`Database ${database_id} is not linked to "${name(project.name)}".`)
    await rest.updateProject(project.uid, changes)
    return text(`Database ${database_id} unlinked from "${name(project.name)}".`)
  }))

  registerDatabaseTools(server)
}
