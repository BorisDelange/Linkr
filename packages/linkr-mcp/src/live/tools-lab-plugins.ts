/** Workspace plugins as code: manifest and R / Python templates. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import { computePluginContentHash } from '@/lib/plugin-hash'
import {
  checkPluginFiles, scaffoldManifest, scaffoldTemplate, templateFile, type PluginLanguage, type PluginScope,
} from './lab-extra.js'
import { DESTRUCTIVE, READ, WRITE, failure, guard, loc, text, type Server } from './shared.js'
import { isBuiltinRow, manifestOf, me, plugins, workspaceOfProject } from './lab-rest.js'

export function registerUserPluginTools(server: Server): void {
  server.registerTool('list_user_plugins', {
    description:
      'The plugins of a workspace (Plugins page): widget types written as R/Python code templates. Scope "lab" '
      + 'plugins run on a dataset (dashboards, dataset analyses); scope "warehouse" plugins run for one patient '
      + '(Patient data boards). Built-in plugins listed there are read-only.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ workspace_id?: string; project_uid?: string }>({
      type: 'object',
      properties: { workspace_id: { type: 'string' }, project_uid: { type: 'string', description: 'Its workspace.' } },
    }),
  }, guard(async ({ workspace_id, project_uid }) => {
    const ws = workspace_id ?? (project_uid ? await workspaceOfProject(project_uid) : null)
    if (!ws) return failure('Give workspace_id or project_uid.')
    const rows = await plugins.list(ws)
    const lines = rows.map((r) => {
      const m = manifestOf(r)
      if (!m) return `- plugin_id: ${r.id} — (unreadable plugin.json)`
      return `- "${loc(m.name)}" — plugin_id: ${r.id} · manifest ${m.id} · ${m.scope ?? 'lab'} · ${(m.languages ?? []).join('/') || 'component'}`
        + ` · v${m.version}${isBuiltinRow(m) ? ' · built-in (read-only)' : ''}`
    })
    return text(lines.length ? lines.join('\n') : 'No plugin in this workspace.')
  }))

  server.registerTool('get_user_plugin', {
    description: 'A workspace plugin\'s files: plugin.json (manifest: id, scope, languages, configSchema…) and its '
      + 'code templates, where {{field}} is replaced by the config value of that configSchema field.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ plugin_id: string; file?: string }>({
      type: 'object',
      properties: { plugin_id: { type: 'string' }, file: { type: 'string', description: 'Only this file.' } },
      required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id, file }) => {
    const row = await plugins.get(plugin_id)
    const names = file ? [file] : Object.keys(row.files).sort((a, b) => Number(a !== 'plugin.json') - Number(b !== 'plugin.json'))
    const out: string[] = []
    for (const f of names) {
      const content = row.files[f]
      if (content === undefined) return failure(`No file ${f} (files: ${Object.keys(row.files).join(', ')}).`)
      out.push(`=== ${f}\n${content.length > 20000 ? `${content.slice(0, 20000)}\n… (truncated)` : content}`)
    }
    return text(out.join('\n\n'))
  }))

  server.registerTool('create_user_plugin', {
    description:
      'Create a workspace plugin: a widget type whose code is an R and/or Python template. Lab scope: the dataset '
      + 'is injected as `dataset` (pandas DataFrame / data.frame). Warehouse scope: person_id, visit_occurrence_id, '
      + 'visit_detail_id are injected and sql_query("…") queries the database. {{field}} in a template is replaced by '
      + 'the config value of that configSchema field (column-select → column name). Without a template, the app\'s '
      + 'starter code is used.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{
      workspace_id?: string; project_uid?: string; name: string; description?: string; scope: PluginScope
      languages?: PluginLanguage[]; config_schema?: Record<string, unknown>; python_template?: string; r_template?: string
      python_dependencies?: string[]; r_dependencies?: string[]; icon?: string
    }>({
      type: 'object',
      properties: {
        workspace_id: { type: 'string' }, project_uid: { type: 'string', description: 'Its workspace.' },
        name: { type: 'string' }, description: { type: 'string' },
        scope: { type: 'string', enum: ['lab', 'warehouse'] },
        languages: { type: 'array', items: { type: 'string', enum: ['python', 'r'] }, description: 'Default ["python"].' },
        config_schema: {
          type: 'object',
          description: 'Settings form fields, keyed by name: {type: column-select|number|select|boolean|string|…, '
            + 'label: {en, fr}, multi?, filter?: numeric|categorical, options?: [{value, label: {en, fr}}], default?}.',
        },
        python_template: { type: 'string' }, r_template: { type: 'string' },
        python_dependencies: { type: 'array', items: { type: 'string' } }, r_dependencies: { type: 'array', items: { type: 'string' } },
        icon: { type: 'string', description: 'A lucide icon name. Default Puzzle.' },
      },
      required: ['name', 'scope'],
    }),
  }, guard(async (a) => {
    const ws = a.workspace_id ?? (a.project_uid ? await workspaceOfProject(a.project_uid) : null)
    if (!ws) return failure('Give workspace_id or project_uid.')
    const languages = a.languages?.length ? [...new Set(a.languages)] : (['python'] as PluginLanguage[])
    const id = `user-plugin-${Date.now()}`
    const manifest = scaffoldManifest({
      id, name: a.name.trim(), description: a.description ?? '', scope: a.scope, languages, icon: a.icon,
      configSchema: a.config_schema, dependencies: { python: a.python_dependencies, r: a.r_dependencies },
    })
    const files: Record<string, string> = {}
    for (const l of languages) {
      files[templateFile(l)] = (l === 'python' ? a.python_template : a.r_template) ?? scaffoldTemplate(a.scope, l)
    }
    files['plugin.json'] = JSON.stringify(manifest, null, 2)
    const checked = checkPluginFiles(files)
    if (checked.errors.length) return failure(`Not created:\n- ${checked.errors.join('\n- ')}`)
    files['plugin.json'] = JSON.stringify({ ...manifest, contentHash: await computePluginContentHash(files) }, null, 2)
    const { authored } = await me()
    await plugins.create({ id, workspaceId: ws, files, lineageId: randomUUID(), ...authored })
    return text(`Created plugin "${a.name}" — plugin_id: ${id}${checked.warnings.length ? `\nWarnings:\n- ${checked.warnings.join('\n- ')}` : ''}`)
  }))

  server.registerTool('update_user_plugin', {
    description:
      'Edit a workspace plugin\'s files (get_user_plugin first): each entry of `files` replaces or adds that file '
      + '(plugin.json included — keep its id), null deletes it. Checked like the app reads it before saving; '
      + 'built-in plugins cannot be edited. Widgets using it pick the change up on their next run.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ plugin_id: string; files: Record<string, string | null>; version?: string }>({
      type: 'object',
      properties: {
        plugin_id: { type: 'string' },
        files: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'file name → content (null deletes).' },
        version: { type: 'string', description: 'Also set the manifest version (semver).' },
      },
      required: ['plugin_id', 'files'],
    }),
  }, guard(async ({ plugin_id, files: changes, version }) => {
    const row = await plugins.get(plugin_id)
    const before = manifestOf(row)
    if (isBuiltinRow(before)) return failure('A built-in plugin is read-only; duplicate it in Linkr to change it.')
    if (changes['plugin.json'] === null) return failure('plugin.json cannot be deleted.')
    const files: Record<string, string> = { ...row.files }
    for (const [f, content] of Object.entries(changes)) {
      if (content === null) delete files[f]
      else files[f] = content
    }
    const checked = checkPluginFiles(files)
    if (checked.errors.length) return failure(`Not saved:\n- ${checked.errors.join('\n- ')}`)
    const manifest = checked.manifest!
    if (before?.id && manifest.id !== before.id) return failure(`The manifest id must stay ${before.id}: widgets reference it.`)
    if (version) manifest.version = version
    files['plugin.json'] = JSON.stringify({ ...manifest, contentHash: await computePluginContentHash(files) }, null, 2)
    await plugins.update(plugin_id, { files, ...(version ? { version } : {}) })
    return text(`Saved plugin ${plugin_id}.${checked.warnings.length ? `\nWarnings:\n- ${checked.warnings.join('\n- ')}` : ''}`)
  }))

  server.registerTool('delete_user_plugin', {
    description: 'Delete a workspace plugin. Widgets that use it stop rendering. Irreversible: ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ plugin_id: string }>({
      type: 'object', properties: { plugin_id: { type: 'string' } }, required: ['plugin_id'],
    }),
  }, guard(async ({ plugin_id }) => {
    const row = await plugins.get(plugin_id)
    const m = manifestOf(row)
    await plugins.remove(plugin_id)
    return text(`Deleted plugin "${m ? loc(m.name) : plugin_id}".`)
  }))
}
