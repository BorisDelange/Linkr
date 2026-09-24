/** IDE scripts and code runs (R, Python) in a project's server-side kernels. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { embedReportHtml } from './report.js'
import { figuresHtml, formatExecution, renderScriptTree, runLanguageFor, type RunLanguage } from './ide.js'
import { DESTRUCTIVE, READ, WRITE, api, failure, guard, text, type Server, type ToolResult } from './shared.js'

const DATA_NOTE = 'Print aggregates (counts, summaries, model coefficients), not patient-level rows: the output '
  + 'is sent to you, and you may be a remote model.'

async function scriptContent(projectUid: string, path: string): Promise<string | null> {
  const file = (await api.listScripts(projectUid)).find((f) => f.type === 'file' && f.path === path)
  return file ? (file.content ?? '') : null
}

async function run(args: {
  project_uid: string; language: RunLanguage; code: string; session?: string
  dataset_path?: string; database_id?: string; label?: string
}): Promise<ToolResult> {
  const out = await api.execute({
    projectUid: args.project_uid, language: args.language, code: args.code,
    sessionId: args.session ?? 'default',
    ...(args.dataset_path ? { datasetFileId: args.dataset_path } : {}),
    ...(args.database_id ? { connectionId: args.database_id } : {}),
    ...(args.label ? { label: args.label } : {}),
  })
  const content: ToolResult['content'] = [{ type: 'text', text: formatExecution(out) }]
  if (out.figures.length) {
    content.push({
      type: 'resource',
      resource: {
        uri: `ui://linkr/figures/${Date.now()}`, mimeType: 'text/html',
        text: embedReportHtml(figuresHtml(out.figures)),
      },
    })
  }
  return { content, ...(out.failed ? { isError: true } : {}) }
}

const RUN_OPTIONS = {
  session: {
    type: 'string',
    description: 'Kernel session. Default "default": the one the user\'s IDE uses, so variables are shared both ways.',
  },
  dataset_path: {
    type: 'string',
    description: 'Load this project dataset (list_datasets) as a data frame named `dataset` before the code runs.',
  },
  database_id: {
    type: 'string',
    description: 'Make sql_query("SELECT …") in the code run against this database, returning a data frame.',
  },
} as const

export function registerIdeTools(server: Server) {
  server.registerTool('list_scripts', {
    description: 'The project\'s IDE scripts (R, Python, SQL, Markdown…) as a tree, with line counts.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => text(renderScriptTree(await api.listScripts(project_uid)))))

  server.registerTool('read_script', {
    description: 'The content of one IDE script.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string', description: 'e.g. "analysis/model.R"' } },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    const content = await scriptContent(project_uid, path)
    return content === null ? failure(`No script "${path}" — see list_scripts.`) : text(content || '(empty file)')
  }))

  server.registerTool('write_script', {
    description: 'Create or overwrite an IDE script (folders are created as needed). It shows in the user\'s IDE. '
      + 'Overwriting replaces the whole file: read_script first to keep what is there.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; content: string }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string', description: 'Relative path with extension, e.g. "analysis/table1.R".' },
        content: { type: 'string' },
      },
      required: ['project_uid', 'path', 'content'],
    }),
  }, guard(async ({ project_uid, path, content }) => {
    const exists = (await scriptContent(project_uid, path)) !== null
    if (exists) await api.saveScript(project_uid, path, content)
    else await api.createScript(project_uid, path, content)
    return text(`${exists ? 'Updated' : 'Created'} ${path} (${content.split('\n').length} lines).`)
  }))

  server.registerTool('move_script', {
    description: 'Rename or move an IDE script or folder.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; new_path: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, new_path: { type: 'string' } },
      required: ['project_uid', 'path', 'new_path'],
    }),
  }, guard(async ({ project_uid, path, new_path }) => {
    await api.moveScript(project_uid, path, new_path)
    return text(`Moved ${path} → ${new_path}.`)
  }))

  server.registerTool('delete_script', {
    description: 'Delete an IDE script or folder (with its content). Ask the user first: this cannot be undone.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; path: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' } },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ project_uid, path }) => {
    await api.deleteScript(project_uid, path)
    return text(`Deleted ${path}.`)
  }))

  server.registerTool('run_code', {
    description: 'Run R or Python code in the project\'s server kernel (its managed environment and packages) and '
      + 'return stdout, stderr, a returned data frame (as a table) and figures (rendered for the user). '
      + `Variables persist between runs of the same session. ${DATA_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: fromJsonSchema<{
      project_uid: string; language: RunLanguage; code: string; session?: string; dataset_path?: string; database_id?: string
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        language: { type: 'string', enum: ['r', 'python'] },
        code: { type: 'string' },
        ...RUN_OPTIONS,
      },
      required: ['project_uid', 'language', 'code'],
    }),
  }, guard(async (args) => run(args)))

  server.registerTool('run_script', {
    description: `Run one IDE script (.R or .py) in the project's server kernel, as the IDE's Run button does. ${DATA_NOTE}`,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: fromJsonSchema<{ project_uid: string; path: string; session?: string; dataset_path?: string; database_id?: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, path: { type: 'string' }, ...RUN_OPTIONS },
      required: ['project_uid', 'path'],
    }),
  }, guard(async ({ path, ...rest }) => {
    const language = runLanguageFor(path)
    if (!language) return failure(`${path} is not an R or Python script. SQL runs with run_sql.`)
    const code = await scriptContent(rest.project_uid, path)
    if (code === null) return failure(`No script "${path}" — see list_scripts.`)
    return run({ ...rest, language, code, label: path })
  }))
}
