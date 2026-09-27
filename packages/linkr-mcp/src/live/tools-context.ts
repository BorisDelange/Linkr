/** Where the user is (the defaults behind "this cohort", "here") and which projects exist:
 *  always on, whatever toolsets are enabled. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { describeMapping } from './cohorts.js'
import { READ, api, guard, loc, projectDatabases, text, type Server } from './shared.js'

export function registerContextTools(server: Server): void {
  server.registerTool('get_ui_context', {
    description:
      'Where the user currently is in Linkr: the project, the page, and the open cohort, dashboard (with '
      + 'its active tab) or dataset — in the browser tab they last focused. Call it when the request says '
      + '"this", "here" or names nothing: use these ids as defaults. Tools can still act anywhere; if nothing '
      + 'is open, or it is ambiguous, ask the user.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => {
    const ctx = await api.getUiContext()
    if (!ctx) return text('No Linkr tab is open for this user: ask which project (list_projects) and item they mean.')
    const lines = Object.entries(ctx)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${String(v)}`)
    return text(lines.join('\n'))
  }))


  server.registerTool('list_projects', {
    description:
      'List the Linkr projects you can access. A project is a study workspace: it links one or more '
      + 'clinical databases (usually OMOP or MIMIC) and holds cohorts, datasets and dashboards. '
      + 'Start here to find the project_uid the other tools need.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => {
    const projects = await api.listProjects()
    if (projects.length === 0) return text('No project accessible.')
    return text(projects.map((p) =>
      `- ${loc(p.name)} — project_uid: ${p.uid}`
      + `${p.linkedDataSourceIds?.length ? ` · ${p.linkedDataSourceIds.length} database(s)` : ' · no database'}`,
    ).join('\n'))
  }))

  server.registerTool('get_project_context', {
    description:
      'Everything needed before working on a project: its description, its linked databases with their '
      + 'schema mapping in plain words (which table holds patients, hospital stays, unit stays, measurements, '
      + 'concept dictionaries), and its existing cohorts. Read this before creating or editing a cohort.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' } },
      required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const project = await api.getProject(project_uid)
    const dbs = await projectDatabases(project_uid)
    const cohorts = await api.listCohorts(project_uid)
    const out = [`Project "${loc(project.name)}" (project_uid ${project.uid})`]
    if (loc(project.description)) out.push(loc(project.description).slice(0, 1500))
    out.push('', `Databases (${dbs.length}):`)
    for (const d of dbs) {
      out.push(`\n## ${loc(d.name)} — database_id: ${d.id} · status: ${d.status}`)
      if (d.status !== 'connected') out.push('(not connected: cannot be queried)')
      else if (d.schemaMapping) out.push(describeMapping(d.schemaMapping))
      else out.push('(no schema mapping: SQL only, no cohort criteria)')
    }
    out.push('', `Cohorts (${cohorts.length}):`)
    for (const c of cohorts) {
      out.push(`- "${loc(c.name)}" — cohort_id: ${c.id} · level ${c.level}`
        + `${c.resultCount != null ? ` · last count ${c.resultCount}` : ''}${c.customSql ? ' · custom SQL' : ''}`)
    }
    return text(out.join('\n'))
  }))
}
