/** The IDE runtime: kernel sessions, scripts run as background jobs, the
 *  project's managed Python/R environments, and its IDE connections. */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { randomUUID } from 'node:crypto'
import type { EnvPackage, EnvInstallOptions, EnvUpdates, Job, ProjectEnvironment } from '@/lib/api/environments'
import type { ExecutionSession } from '@/lib/api/execution-sessions'
import type { IdeConnection } from '@/types'
import { formatJob } from './derive.js'
import { figuresHtml, runLanguageFor } from './ide.js'
import { embedReportHtml } from './report.js'
import {
  buildOptionsOverride, formatEnvironment, formatOptions, formatIdeConnections, formatJobList, formatRunJob, formatSessions,
  parsePackages, type EnvLanguage, type LiveKernel, type OptionsInput,
} from './runtime.js'
import {
  DESTRUCTIVE, READ, WRITE, api, failure, guard, loc, projectDatabases, text, type Server, type ToolResult,
} from './shared.js'

const q = encodeURIComponent
const envPath = (projectUid: string, language: EnvLanguage, rest = '') =>
  `/projects/${q(projectUid)}/environments/${language}${rest}`

const rt = {
  listSessions: (projectUid: string, language?: EnvLanguage) =>
    api.request<ExecutionSession[]>('GET', `/execute/sessions?projectUid=${q(projectUid)}${language ? `&language=${language}` : ''}`),
  createSession: (body: { id: string; projectUid: string; language: EnvLanguage; name: string }) =>
    api.request<ExecutionSession>('POST', '/execute/sessions', body),
  deleteSession: (id: string) => api.request<void>('DELETE', `/execute/sessions/${q(id)}`),
  listKernels: (projectUid: string) => api.request<LiveKernel[]>('GET', `/execute/kernels?projectUid=${q(projectUid)}`),
  restart: (language: EnvLanguage, projectUid: string, sessionId: string) =>
    api.request<void>('POST', '/execute/restart', { language, projectUid, sessionId }),
  interrupt: (language: EnvLanguage, projectUid: string, sessionId: string) =>
    api.request<void>('POST', '/execute/interrupt', { language, projectUid, sessionId }),
  runAsJob: (body: Record<string, unknown>) => api.request<Job>('POST', '/execute/run-as-job', body),
  projectJobs: (projectUid: string) => api.request<Job[]>('GET', `/projects/${q(projectUid)}/jobs`),
  workspaceJobs: (workspaceId: string) => api.request<Job[]>('GET', `/workspaces/${q(workspaceId)}/jobs`),
  clearProjectJobs: (projectUid: string) => api.request<void>('DELETE', `/projects/${q(projectUid)}/jobs`),
  clearWorkspaceJobs: (workspaceId: string) => api.request<void>('DELETE', `/workspaces/${q(workspaceId)}/jobs`),
  environments: (projectUid: string) =>
    api.request<ProjectEnvironment[]>('GET', `/projects/${q(projectUid)}/environments`),
  packages: (p: string, l: EnvLanguage) => api.request<EnvPackage[]>('GET', envPath(p, l, '/packages')),
  cachedUpdates: (p: string, l: EnvLanguage) => api.request<EnvUpdates | null>('GET', envPath(p, l, '/updates')),
  checkUpdates: (p: string, l: EnvLanguage) => api.request<EnvUpdates>('POST', envPath(p, l, '/updates')),
  options: (p: string, l: EnvLanguage) =>
    api.request<{ override: EnvInstallOptions; effective: EnvInstallOptions }>('GET', envPath(p, l, '/options')),
  setOptions: (p: string, l: EnvLanguage, body: EnvInstallOptions) =>
    api.request<{ override: EnvInstallOptions; effective: EnvInstallOptions }>('PUT', envPath(p, l, '/options'), body),
  addPackages: (p: string, l: EnvLanguage, packages: string[]) =>
    api.request<ProjectEnvironment>('POST', envPath(p, l, '/packages'), { packages }),
  removePackage: (p: string, l: EnvLanguage, pkg: string) =>
    api.request<ProjectEnvironment>('DELETE', envPath(p, l, `/packages/${q(pkg)}`)),
  upgrade: (p: string, l: EnvLanguage, pkg?: string) =>
    api.request<ProjectEnvironment>('POST', envPath(p, l, `/upgrade${pkg ? `?package=${q(pkg)}` : ''}`)),
  preset: (p: string, l: EnvLanguage) => api.request<ProjectEnvironment>('POST', envPath(p, l, '/preset')),
  build: (p: string, l: EnvLanguage) => api.request<Job>('POST', envPath(p, l, '/build')),
  ideConnections: (projectUid: string) =>
    api.request<IdeConnection[]>('GET', `/ide-connections?projectUid=${q(projectUid)}`),
}

const LANGUAGE = { type: 'string', enum: ['python', 'r'] } as const
const SESSION = {
  type: 'string',
  description: 'Kernel session id. Default "default": the one the user\'s IDE uses (list_sessions for the others).',
} as const
const ENV_NOTE = 'Each project has one Python and one R environment (managed with uv / renv); its spec is versioned '
  + 'with the project. The server re-locks the spec here; the packages are installed by a build (build: true, '
  + 'build_environment, or automatically on the next run).'

const languagesOf = (language?: EnvLanguage): EnvLanguage[] => (language ? [language] : ['python', 'r'])

async function describeEnv(projectUid: string, env: ProjectEnvironment): Promise<string> {
  const language = env.language
  const [packages, updates, options] = await Promise.all([
    rt.packages(projectUid, language),
    rt.cachedUpdates(projectUid, language).catch(() => null),
    rt.options(projectUid, language).catch(() => null),
  ])
  return formatEnvironment({ env, packages, updates, options })
}

/** After a package op: the new state, and the build job when one was asked for. */
async function afterPackageOp(projectUid: string, language: EnvLanguage, env: ProjectEnvironment, what: string, build?: boolean) {
  const lines = [what, `Environment status: ${env.status}.`]
  if (build) {
    const job = await rt.build(projectUid, language)
    lines.push(`Build started — job_id: ${job.id}. Follow it with get_job_status; runs wait for it to finish.`)
  } else if (env.status === 'draft') {
    lines.push('Not built yet: build_environment installs it now, else the next run builds it first (can take minutes).')
  }
  if (env.staleSessions?.length) {
    lines.push(`After the build, sessions ${env.staleSessions.join(', ')} still run the previous environment until restart_kernel.`)
  }
  return text(lines.join('\n'))
}

function jobResource(job: Job): ToolResult['content'] {
  const figures = job.result?.figures ?? []
  if (!figures.length) return []
  const html = figuresHtml(figures.map((f, i) => ({ id: f.id ?? `fig-${i}`, type: f.type, data: f.data, label: f.label ?? '' })))
  return [{ type: 'resource', resource: { uri: `ui://linkr/job-figures/${job.id}`, mimeType: 'text/html', text: embedReportHtml(html) } }]
}

export function registerRuntimeTools(server: Server): void {
  // --- Kernel sessions -------------------------------------------------------

  server.registerTool('list_sessions', {
    description: 'The user\'s kernel sessions in a project: named, isolated R / Python namespaces (variables live '
      + 'per session) — "default" first, the one the IDE uses — with the state of each live kernel '
      + '(idle / running code, memory). Pass a session id as `session` to run_code / run_script.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; language?: EnvLanguage }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: { ...LANGUAGE, description: 'Only this language. Default both.' } },
      required: ['project_uid'],
    }),
  }, guard(async ({ project_uid, language }) => {
    const [sessions, kernels] = await Promise.all([rt.listSessions(project_uid, language), rt.listKernels(project_uid)])
    return text(formatSessions(sessions, kernels, languagesOf(language)))
  }))

  server.registerTool('create_session', {
    description: 'Create a named kernel session: a separate R or Python namespace, so a long analysis does not share '
      + 'variables with the IDE\'s "default" one. The user sees it in the IDE\'s Session menu (after a reload).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; name: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: LANGUAGE, name: { type: 'string' } },
      required: ['project_uid', 'language', 'name'],
    }),
  }, guard(async ({ project_uid, language, name }) => {
    if (!name.trim()) return failure('Give the session a name.')
    const session = await rt.createSession({ id: randomUUID(), projectUid: project_uid, language, name: name.trim() })
    return text(`Created ${language} session "${session.name}" — session: ${session.id}. `
      + 'Its kernel starts on the first run_code with this session.')
  }))

  server.registerTool('delete_session', {
    description: 'Delete a named kernel session and stop its kernel: its variables are lost. The "default" session '
      + 'cannot be deleted (restart_kernel clears it). Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ session_id: string }>({
      type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'],
    }),
  }, guard(async ({ session_id }) => {
    if (session_id === 'default') return failure('The default session cannot be deleted; restart_kernel clears it.')
    await rt.deleteSession(session_id)
    return text(`Deleted session ${session_id} and stopped its kernel.`)
  }))

  server.registerTool('restart_kernel', {
    description: 'Restart a session\'s R or Python kernel: every variable of that session is lost (in the user\'s IDE '
      + 'too for "default"); the next run starts clean, on the current environment build. Needed after a build so '
      + 'the session sees new packages. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; session?: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: LANGUAGE, session: SESSION },
      required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language, session }) => {
    await rt.restart(language, project_uid, session ?? 'default')
    return text(`Restarted the ${language} kernel of session "${session ?? 'default'}".`)
  }))

  server.registerTool('interrupt_kernel', {
    description: 'Interrupt the code a session\'s kernel is running (the IDE\'s Stop button). Variables are kept. '
      + 'A no-op when nothing runs.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; session?: string }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: LANGUAGE, session: SESSION },
      required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language, session }) => {
    await rt.interrupt(language, project_uid, session ?? 'default')
    return text(`Interrupt sent to the ${language} kernel of session "${session ?? 'default'}".`)
  }))

  // --- Background jobs -------------------------------------------------------

  server.registerTool('run_as_job', {
    description: 'Run an IDE script (path) or R / Python code as a background job — the IDE\'s "Run as job": a fresh '
      + 'process (no session variables), for long runs. Returns the job_id at once; follow it with get_job_status '
      + 'and read its output (log, table, figures) with get_job_output. The user sees it in Linkr\'s jobs panel. '
      + 'sql_query() is not available in a job. Print aggregates, not patient-level rows. The job runs with the '
      + 'user\'s rights and can overwrite or delete files, datasets and writable databases.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{
      project_uid: string; path?: string; code?: string; language?: EnvLanguage; dataset_path?: string; label?: string
    }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        path: { type: 'string', description: 'An .R or .py script from list_scripts. Or give code + language.' },
        code: { type: 'string' },
        language: { ...LANGUAGE, description: 'Required with code; taken from the extension with path.' },
        dataset_path: {
          type: 'string',
          description: 'Load this project dataset (list_datasets) as a data frame named `dataset` before the code runs.',
        },
        label: { type: 'string', description: 'Shown in the jobs panel. Default: the script path.' },
      },
      required: ['project_uid'],
    }),
  }, guard(async ({ project_uid, path, code, language, dataset_path, label }) => {
    if (!!path === (code !== undefined)) return failure('Give either path or code (with language).')
    let lang = language
    let source = code
    if (path) {
      lang = runLanguageFor(path) ?? undefined
      if (!lang) return failure(`${path} is not an R or Python script.`)
      const file = (await api.listScripts(project_uid)).find((f) => f.type === 'file' && f.path === path)
      if (!file) return failure(`No script "${path}" — see list_scripts.`)
      source = file.content ?? ''
    }
    if (!lang) return failure('language is required with code.')
    if (!source?.trim()) return failure('Nothing to run: the code is empty.')
    const job = await rt.runAsJob({
      language: lang, code: source, projectUid: project_uid,
      datasetFileId: dataset_path ?? null, label: label ?? path ?? null, purpose: 'ide',
    })
    return text(`Started "${job.label}" — job_id: ${job.id} (${job.status}). `
      + 'Poll get_job_status, then get_job_output for its output.')
  }))

  server.registerTool('get_job_output', {
    description: 'The output of a job, beyond get_job_status: for a script run as a job (run_as_job) its full log '
      + '(stdout / stderr), result table and figures (shown to the user); for other jobs (environment build, '
      + 'package install, derivation) the status and log tail.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ job_id: string }>({
      type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'],
    }),
  }, guard(async ({ job_id }) => {
    const job = await api.getJob(job_id)
    if (job.kind !== 'run') return text(formatJob(job))
    return {
      content: [{ type: 'text', text: formatRunJob(job) }, ...(job.status === 'done' ? jobResource(job) : [])],
      ...(job.status === 'error' ? { isError: true } : {}),
    }
  }))

  server.registerTool('list_jobs', {
    description: 'The user\'s recent jobs (the jobs panel, last 20, newest first): of a project — script runs, '
      + 'environment builds, package installs — or of a workspace — database derivations. Give project_uid or workspace_id.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid?: string; workspace_id?: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, workspace_id: { type: 'string' } },
    }),
  }, guard(async ({ project_uid, workspace_id }) => {
    if (!!project_uid === !!workspace_id) return failure('Give either project_uid or workspace_id.')
    return text(formatJobList(project_uid ? await rt.projectJobs(project_uid) : await rt.workspaceJobs(workspace_id!)))
  }))

  server.registerTool('clear_finished_jobs', {
    description: 'Remove the user\'s finished jobs (done / error / cancelled) from a project\'s or workspace\'s jobs '
      + 'panel, with their stored output. Running jobs are kept. Ask the user first.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid?: string; workspace_id?: string }>({
      type: 'object', properties: { project_uid: { type: 'string' }, workspace_id: { type: 'string' } },
    }),
  }, guard(async ({ project_uid, workspace_id }) => {
    if (!!project_uid === !!workspace_id) return failure('Give either project_uid or workspace_id.')
    if (project_uid) await rt.clearProjectJobs(project_uid)
    else await rt.clearWorkspaceJobs(workspace_id!)
    return text('Cleared the finished jobs.')
  }))

  // --- Environments ----------------------------------------------------------

  server.registerTool('describe_environment', {
    description: `The project's R and/or Python environment: status (draft / building / ready / error), declared `
      + `packages with their version constraint, the last update check, install options (package repository / `
      + `index), and sessions still on a previous build. ${ENV_NOTE}`,
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string; language?: EnvLanguage }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: { ...LANGUAGE, description: 'Default both.' } },
      required: ['project_uid'],
    }),
  }, guard(async ({ project_uid, language }) => {
    const envs = (await rt.environments(project_uid)).filter((e) => !language || e.language === language)
    if (envs.length === 0) return failure(`No ${language ?? ''} environment for project ${project_uid} — see list_projects.`)
    return text((await Promise.all(envs.map((e) => describeEnv(project_uid, e)))).join('\n\n'))
  }))

  const BUILD = {
    type: 'boolean',
    description: 'Also start the environment build now (a job). Default false: the next run builds it.',
  } as const

  server.registerTool('install_packages', {
    description: `Add packages to the project's R or Python environment, as the Environments panel does. ${ENV_NOTE} `
      + 'Pins are allowed ("dplyr==1.1.4", "pandas>=2"). Dependencies come along. Installing runs the packages\' '
      + 'own build and install code on the server, which can overwrite or delete data.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; packages: string[]; build?: boolean }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        language: LANGUAGE,
        packages: { type: 'array', items: { type: 'string' }, minItems: 1 },
        build: BUILD,
      },
      required: ['project_uid', 'language', 'packages'],
    }),
  }, guard(async ({ project_uid, language, packages, build }) => {
    const names = parsePackages(packages)
    if (names.length === 0) return failure('No package given.')
    const env = await rt.addPackages(project_uid, language, names)
    return afterPackageOp(project_uid, language, env, `Added ${names.join(', ')} to the ${language} environment.`, build)
  }))

  server.registerTool('remove_package', {
    description: 'Remove a package from the project\'s R or Python environment (kernel packages cannot be removed). '
      + 'Code using it will fail after the next build.',
    annotations: DESTRUCTIVE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; package: string; build?: boolean }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: LANGUAGE, package: { type: 'string' }, build: BUILD },
      required: ['project_uid', 'language', 'package'],
    }),
  }, guard(async ({ project_uid, language, package: pkg, build }) => {
    const env = await rt.removePackage(project_uid, language, pkg.trim())
    return afterPackageOp(project_uid, language, env, `Removed ${pkg.trim()} from the ${language} environment.`, build)
  }))

  server.registerTool('update_packages', {
    description: 'Update one package, or all, of the project\'s R or Python environment to the newest versions '
      + 'the repository allows (re-locks the spec). check_package_updates first shows what would change.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; package?: string; build?: boolean }>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        language: LANGUAGE,
        package: { type: 'string', description: 'Default: all packages.' },
        build: BUILD,
      },
      required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language, package: pkg, build }) => {
    const env = await rt.upgrade(project_uid, language, pkg?.trim() || undefined)
    return afterPackageOp(project_uid, language, env, `Updated ${pkg?.trim() || 'all packages'} in the ${language} environment.`, build)
  }))

  server.registerTool('install_package_preset', {
    description: 'Add the workspace\'s default data-science package set to the project\'s R or Python environment '
      + '(what the Environments panel\'s preset button does).',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage; build?: boolean }>({
      type: 'object',
      properties: { project_uid: { type: 'string' }, language: LANGUAGE, build: BUILD },
      required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language, build }) => {
    const env = await rt.preset(project_uid, language)
    return afterPackageOp(project_uid, language, env, `Added the default package set to the ${language} environment.`, build)
  }))

  server.registerTool('check_package_updates', {
    description: 'Ask the package repository which packages of the project\'s R or Python environment have a newer '
      + 'version (one network query, up to a minute or two). Changes nothing; the result is cached for describe_environment.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage }>({
      type: 'object', properties: { project_uid: { type: 'string' }, language: LANGUAGE }, required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language }) => {
    const res = await rt.checkUpdates(project_uid, language)
    const entries = Object.entries(res.packages ?? {})
    if (entries.length === 0) return text(`Every ${language} package is up to date (checked ${res.checkedAt}).`)
    const shown = entries.slice(0, 100).map(([name, latest]) => `- ${name} → ${latest}`)
    return text([`${entries.length} package(s) with a newer version (checked ${res.checkedAt}):`, ...shown,
      ...(entries.length > 100 ? [`… ${entries.length - 100} more`] : []), 'update_packages applies them.'].join('\n'))
  }))

  server.registerTool('build_environment', {
    description: 'Build (install) the project\'s R or Python environment from its declared packages, as a background '
      + 'job. Returns the job_id at once; follow it with get_job_status. Sessions opened before keep the old build '
      + 'until restart_kernel.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage }>({
      type: 'object', properties: { project_uid: { type: 'string' }, language: LANGUAGE }, required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language }) => {
    const job = await rt.build(project_uid, language)
    return text(`Build of the ${language} environment started — job_id: ${job.id} (${job.status}). Follow it with get_job_status.`)
  }))

  server.registerTool('set_environment_options', {
    description: 'Set where the project\'s R or Python environment downloads packages from (e.g. a hospital mirror). '
      + 'R: repos (CRAN-like URL) and method (download method). Python: index_url and trusted_host. Only the fields '
      + 'given change; "" clears one, falling back to the workspace default, then the server\'s. Versioned with the '
      + 'project. URLs with credentials are refused.',
    annotations: WRITE,
    inputSchema: fromJsonSchema<{ project_uid: string; language: EnvLanguage } & OptionsInput>({
      type: 'object',
      properties: {
        project_uid: { type: 'string' },
        language: LANGUAGE,
        repos: { type: 'string', description: 'R: package repository URL.' },
        method: { type: 'string', description: 'R: auto, libcurl, curl, wget, internal or wininet.' },
        index_url: { type: 'string', description: 'Python: package index URL.' },
        trusted_host: { type: 'string', description: 'Python: host trusted without TLS verification.' },
      },
      required: ['project_uid', 'language'],
    }),
  }, guard(async ({ project_uid, language, ...input }) => {
    const current = await rt.options(project_uid, language)
    const built = buildOptionsOverride(language, current.override, input)
    if ('error' in built) return failure(built.error)
    const res = await rt.setOptions(project_uid, language, built.override)
    return text(`Install options of the ${language} environment: override ${formatOptions(res.override)}; `
      + `effective ${formatOptions(res.effective)}. Takes effect on the next install, update or build.`)
  }))

  // --- IDE connections -------------------------------------------------------

  server.registerTool('list_ide_connections', {
    description: 'The databases a project\'s scripts can query: its linked Linkr databases (database_id for '
      + 'run_code / run_script, read with sql_query("…") in the code) and the custom connections added in the IDE. '
      + 'Connection fields only, never credentials.',
    annotations: READ,
    inputSchema: fromJsonSchema<{ project_uid: string }>({
      type: 'object', properties: { project_uid: { type: 'string' } }, required: ['project_uid'],
    }),
  }, guard(async ({ project_uid }) => {
    const [databases, custom] = await Promise.all([projectDatabases(project_uid), rt.ideConnections(project_uid)])
    const linked = databases.filter((d) => d.sourceType === 'database').map((d) => ({
      id: d.id,
      name: loc(d.name),
      engine: (d as { connectionConfig?: { engine?: string } }).connectionConfig?.engine,
      status: d.status,
    }))
    return text(formatIdeConnections(linked, custom))
  }))
}
