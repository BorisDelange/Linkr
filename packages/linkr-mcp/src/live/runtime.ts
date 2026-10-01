/** Pure helpers for the IDE runtime: kernel sessions, background jobs, managed
 *  environments and IDE connections. */
import type { EnvPackage, EnvInstallOptions, EnvUpdates, Job, ProjectEnvironment } from '@/lib/api/environments'
import type { ExecutionSession } from '@/lib/api/execution-sessions'
import type { IdeConnection } from '@/types'
import { formatExecution } from './ide.js'
import { AGENT_SESSION } from './shared.js'

export type EnvLanguage = 'python' | 'r'

/** One entry of GET /execute/kernels (built by the kernel manager, already camelCase). */
export interface LiveKernel {
  language: string
  sessionId: string
  alive: boolean
  busy: boolean
  pid: number | null
  rssKb: number | null
  idleSeconds: number
}

const LANGUAGE_LABEL: Record<string, string> = { python: 'Python', r: 'R' }

function kernelState(k: LiveKernel | undefined): string {
  if (!k || !k.alive) return 'no live kernel (starts on the next run)'
  const mem = k.rssKb != null ? `, ${Math.round(k.rssKb / 1024)} MB` : ''
  return `${k.busy ? 'running code' : `idle ${k.idleSeconds}s`}${mem}`
}

/**
 * Sessions per language — the implicit `default` and agent ones first, then the named ones —
 * each with the state of its live kernel. A live kernel with no named session
 * (other than default) is listed too, so nothing running is hidden.
 */
export function formatSessions(
  sessions: ExecutionSession[],
  kernels: LiveKernel[],
  languages: EnvLanguage[],
): string {
  const blocks = languages.map((language) => {
    const live = kernels.filter((k) => k.language === language)
    const named = sessions.filter((s) => s.language === language)
    const known = new Set(['default', AGENT_SESSION, ...named.map((s) => s.id)])
    const rows = [
      `- default (session "default", the user's IDE: closed to agents) — ${kernelState(live.find((k) => k.sessionId === 'default'))}`,
      `- agent (session "${AGENT_SESSION}", run_code's default) — ${kernelState(live.find((k) => k.sessionId === AGENT_SESSION))}`,
      ...named.map((s) => `- "${s.name}" (session "${s.id}") — ${kernelState(live.find((k) => k.sessionId === s.id))}`),
      ...live.filter((k) => !known.has(k.sessionId)).map((k) => `- session "${k.sessionId}" — ${kernelState(k)}`),
    ]
    return `${LANGUAGE_LABEL[language]}:\n${rows.join('\n')}`
  })
  return blocks.join('\n\n')
}

/** Jobs as one line each, newest first as the server returns them. */
export function formatJobList(jobs: Job[]): string {
  if (jobs.length === 0) return 'No recent job.'
  return jobs.map((j) => {
    const progress = j.status === 'running' && j.progress ? ` ${j.progress}%` : ''
    return `- ${j.createdAt.slice(0, 19).replace('T', ' ')} · ${j.kind} · "${j.label}" — ${j.status}${progress} · job_id: ${j.id}`
  }).join('\n')
}

/** A `run` job (a script run as a background job) as the model reads it: its
 *  status, then its output once finished — the streamed log plus the collected
 *  table and figures. */
export function formatRunJob(job: Job, maxChars = 6000): string {
  const head = `Job ${job.id} (${job.kind}) "${job.label}": ${job.status}${job.status === 'running' ? `, ${job.progress}%` : ''}`
  if (job.status === 'queued' || job.status === 'running') {
    const tail = job.logTail?.split('\n').filter(Boolean).slice(-15) ?? []
    return [head, 'Still in progress: check again later.', ...(tail.length ? ['', 'Output so far:', ...tail] : [])].join('\n')
  }
  const result = job.result ?? {}
  const body = formatExecution({
    stdout: job.logTail ?? '',
    stderr: '',
    figures: (result.figures ?? []).map((f, i) => ({ id: f.id ?? `fig-${i}`, type: f.type, data: f.data, label: f.label ?? '' })),
    table: result.table ?? null,
    html: result.html ?? null,
    failed: job.status === 'error',
  }, maxChars)
  // formatExecution opens with its own verdict line; the job status replaces it.
  return [head, ...body.split('\n\n').slice(1)].join('\n\n')
}

/** A URL with any `user:password@` part masked: an index URL may carry credentials. */
export function redactUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1***@')
}

export function formatOptions(options: EnvInstallOptions): string {
  const entries = Object.entries(options).filter(([, v]) => v)
  if (entries.length === 0) return '(none)'
  return entries.map(([k, v]) => `${k}=${k === 'repos' || k === 'indexUrl' ? redactUrl(String(v)) : v}`).join(', ')
}

export interface EnvironmentView {
  env: ProjectEnvironment
  packages: EnvPackage[]
  updates: EnvUpdates | null
  options: { override: EnvInstallOptions; effective: EnvInstallOptions } | null
}

const STATUS_NOTE: Record<ProjectEnvironment['status'], string> = {
  draft: 'the declared packages changed and are not built yet — build_environment, or the next run builds it',
  building: 'a build is in progress',
  ready: 'built, runs use it',
  error: 'the last build failed — see list_jobs / get_job_status for its log',
}

/** One language's environment: status, packages (bounded), last update check,
 *  install options, and sessions still on the previous build. */
export function formatEnvironment(view: EnvironmentView, maxPackages = 150): string {
  const { env, packages, updates, options } = view
  const lines = [
    `${LANGUAGE_LABEL[env.language]} environment — ${env.kind === 'system' ? 'system (no package declared yet; the server\'s interpreter)' : 'managed (the project\'s own packages)'}`,
    `Status: ${env.status} — ${STATUS_NOTE[env.status] ?? ''}`,
  ]
  if (env.staleSessions?.length) {
    lines.push(`Sessions still on the previous build (restart_kernel to load new packages; it clears their variables): ${env.staleSessions.join(', ')}`)
  }
  const outdated = updates?.packages ?? {}
  if (packages.length === 0) lines.push('Packages: none declared.')
  else {
    lines.push(`Packages (${packages.length}):`)
    for (const p of packages.slice(0, maxPackages)) {
      const latest = outdated[p.name] ? ` → ${outdated[p.name]} available` : ''
      lines.push(`- ${p.name}${p.spec ? ` ${p.spec}` : ''}${p.system ? ' (kernel package, cannot be removed)' : ''}${latest}`)
    }
    if (packages.length > maxPackages) lines.push(`… ${packages.length - maxPackages} more`)
  }
  lines.push(updates
    ? `Last update check: ${updates.checkedAt} — ${Object.keys(outdated).length} package(s) with a newer version.`
    : 'Updates: never checked (check_package_updates).')
  if (options) {
    lines.push(`Install options: override ${formatOptions(options.override)}; effective ${formatOptions(options.effective)}`)
  }
  return lines.join('\n')
}

/** Package refs as the app's Add box accepts them: comma / whitespace
 *  separated, each optionally pinned ("dplyr==1.2.1, tidyr"). */
export function parsePackages(input: string[] | string): string[] {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((s) => s.split(/[,\s]+/))
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))]
}

const R_METHODS = ['auto', 'libcurl', 'curl', 'wget', 'internal', 'wininet']
const URL_RE = /^https?:\/\/[^\s'"\\`;]+$/

export interface OptionsInput { repos?: string; method?: string; index_url?: string; trusted_host?: string }

/**
 * The per-environment install-options override to PUT, merged over the current
 * one (a field passed as "" clears it, falling back to the workspace / server
 * default). Refuses what the server would silently drop, and URLs carrying
 * credentials — an agent never sets a secret.
 */
export function buildOptionsOverride(
  language: EnvLanguage,
  current: EnvInstallOptions,
  input: OptionsInput,
): { override: EnvInstallOptions } | { error: string } {
  const wanted: EnvInstallOptions = language === 'r'
    ? { repos: input.repos, method: input.method }
    : { indexUrl: input.index_url, trustedHost: input.trusted_host }
  const foreign = language === 'r'
    ? (input.index_url !== undefined || input.trusted_host !== undefined)
    : (input.repos !== undefined || input.method !== undefined)
  if (foreign) {
    return { error: language === 'r' ? 'R takes repos and method (index_url / trusted_host are Python\'s).'
      : 'Python takes index_url and trusted_host (repos / method are R\'s).' }
  }
  const next: EnvInstallOptions = { ...current }
  for (const [key, raw] of Object.entries(wanted) as [keyof EnvInstallOptions, string | undefined][]) {
    if (raw === undefined) continue
    const value = raw.trim()
    if (!value) { delete next[key]; continue }
    if (key === 'repos' || key === 'indexUrl') {
      if (!URL_RE.test(value)) return { error: `${key} must be an http(s) URL without quotes, spaces or semicolons.` }
      if (/^https?:\/\/[^/@]+@/i.test(value)) {
        return { error: 'The URL carries credentials: the user sets those in Linkr, never through this tool.' }
      }
    }
    if (key === 'method' && !R_METHODS.includes(value)) return { error: `method must be one of ${R_METHODS.join(', ')}.` }
    next[key] = value
  }
  return { override: next }
}

const SAFE_CONFIG_KEYS = ['engine', 'host', 'port', 'database', 'schema', 'serverPath', 'fileNames'] as const

/** A project's IDE connections — the databases its scripts can query — with
 *  only non-secret connection fields. */
export function formatIdeConnections(
  linked: { id: string; name: string; engine?: string; status: string }[],
  custom: IdeConnection[],
): string {
  const lines: string[] = []
  if (linked.length) {
    lines.push('Project databases (pass as database_id to run_code / run_script, then sql_query("…") in the code):')
    for (const d of linked) lines.push(`- "${d.name}" — database_id: ${d.id}${d.engine ? ` · ${d.engine}` : ''} · ${d.status}`)
  }
  if (custom.length) {
    if (lines.length) lines.push('')
    lines.push('Custom IDE connections (added in the IDE\'s Connections panel; queried from the browser — '
      + 'server-run code cannot reach them, their id is not a database_id):')
    for (const c of custom) {
      const cfg = (c.connectionConfig ?? {}) as unknown as Record<string, unknown>
      const fields = SAFE_CONFIG_KEYS.filter((k) => cfg[k] != null && cfg[k] !== '')
        .filter((k) => k !== 'engine')
        .map((k) => `${k}=${Array.isArray(cfg[k]) ? (cfg[k] as unknown[]).join('|') : String(cfg[k])}`)
      lines.push(`- "${c.name}" — connection id: ${c.id} · ${String(cfg.engine ?? '?')} · ${c.status ?? 'unknown'}`
        + `${fields.length ? ` · ${fields.join(', ')}` : ''}${c.errorMessage ? ` · error: ${c.errorMessage}` : ''}`)
    }
  }
  return lines.length ? lines.join('\n') : 'No database connection in this project.'
}
