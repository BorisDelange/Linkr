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

export interface Job {
  id: string
  projectUid: string
  kind: string
  label: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  progress: number
  logTail: string
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
