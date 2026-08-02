import { apiRequest } from '@/lib/api-client'

/** A project's per-language environment (server mode). One per language. */
export interface ProjectEnvironment {
  id: string
  projectUid: string
  language: 'python' | 'r'
  kind: 'system' | 'managed'
  status: 'draft' | 'building' | 'ready' | 'error'
  interpreterPath: string | null
}

export interface EnvPackage {
  name: string
  /** Version constraint as declared ("==2.1.4", ">=1", or ""). */
  spec: string
}

export function listEnvironments(projectUid: string): Promise<ProjectEnvironment[]> {
  return apiRequest(`/projects/${projectUid}/environments`)
}

export function listEnvPackages(
  projectUid: string,
  language: 'python' | 'r',
): Promise<EnvPackage[]> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/packages`)
}

/** Result of an on-demand "check for updates": which installed packages have a
 *  newer version on the repo, plus when the check ran. */
export interface EnvUpdates {
  packages: Record<string, string>
  checkedAt: string
}

/** The LAST cached update check (null if never run). Reading this never triggers a
 *  check or hits the network beyond the local cache. */
export function getEnvUpdates(
  projectUid: string,
  language: 'python' | 'r',
): Promise<EnvUpdates | null> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/updates`)
}

/** Run the on-demand outdated check (one batch repo query) and cache it. Only call
 *  from an explicit user action — never on modal open or after an install. */
export function checkEnvUpdates(
  projectUid: string,
  language: 'python' | 'r',
): Promise<EnvUpdates> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/updates`, { method: 'POST' })
}

export function addEnvPackages(
  projectUid: string,
  language: 'python' | 'r',
  packages: string[],
): Promise<ProjectEnvironment> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/packages`, {
    method: 'POST',
    body: JSON.stringify({ packages }),
  })
}

/** Restore a managed environment's spec files (manifest + lockfile) on disk during
 *  a project import/clone, so the versioned env travels with the project. Writes
 *  only; the venv/library is rebuilt on demand. */
export function importEnvSpec(
  projectUid: string,
  language: 'python' | 'r',
  files: { name: string; content: string }[],
): Promise<void> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/spec`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  })
}

export function removeEnvPackage(
  projectUid: string,
  language: 'python' | 'r',
  pkg: string,
): Promise<ProjectEnvironment> {
  return apiRequest(
    `/projects/${projectUid}/environments/${language}/packages/${encodeURIComponent(pkg)}`,
    { method: 'DELETE' },
  )
}

/** A 'run' job's collected artifacts (figures/table/html), or null. */
export interface JobResult {
  figures?: Array<{ id?: string; type: 'svg' | 'png'; data: string; label?: string }>
  table?: { headers: string[]; rows: string[][] } | null
  html?: string | null
}

export interface Job {
  id: string
  projectUid: string
  kind: string
  label: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  logTail: string
  result?: JobResult | null
  createdAt: string
}

/** Kick off a manual build; returns the queued job. Poll listJobs for progress. */
export function buildEnvironment(
  projectUid: string,
  language: 'python' | 'r',
): Promise<Job> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/build`, {
    method: 'POST',
  })
}

/** Record the workspace's default data-science package set into this env. */
export function installPreset(
  projectUid: string,
  language: 'python' | 'r',
): Promise<ProjectEnvironment> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/preset`, {
    method: 'POST',
  })
}

/** Re-lock one package (or all, if pkg omitted) to a newer version; env → draft. */
export function upgradeEnvPackages(
  projectUid: string,
  language: 'python' | 'r',
  pkg?: string,
): Promise<ProjectEnvironment> {
  const q = pkg ? `?package=${encodeURIComponent(pkg)}` : ''
  return apiRequest(`/projects/${projectUid}/environments/${language}/upgrade${q}`, {
    method: 'POST',
  })
}

/** Install options for an env: repos/method (R) or indexUrl/trustedHost (Python). */
export interface EnvInstallOptions {
  repos?: string
  method?: string
  indexUrl?: string
  trustedHost?: string
}

export interface EnvOptionsResponse {
  /** The per-env override (only fields the user explicitly set). */
  override: EnvInstallOptions
  /** Effective values after inheriting workspace default + server config. */
  effective: EnvInstallOptions
}

export function getEnvOptions(
  projectUid: string,
  language: 'python' | 'r',
): Promise<EnvOptionsResponse> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/options`)
}

export function setEnvOptions(
  projectUid: string,
  language: 'python' | 'r',
  options: EnvInstallOptions,
): Promise<EnvOptionsResponse> {
  return apiRequest(`/projects/${projectUid}/environments/${language}/options`, {
    method: 'PUT',
    body: JSON.stringify(options),
  })
}

export function listJobs(projectUid: string): Promise<Job[]> {
  return apiRequest(`/projects/${projectUid}/jobs`)
}

export function cancelJob(jobId: string): Promise<void> {
  return apiRequest(`/jobs/${jobId}/cancel`, { method: 'POST' })
}

/** Remove the project's finished jobs (done/error/cancelled); keeps active ones. */
export function clearJobs(projectUid: string): Promise<void> {
  return apiRequest(`/projects/${projectUid}/jobs`, { method: 'DELETE' })
}
