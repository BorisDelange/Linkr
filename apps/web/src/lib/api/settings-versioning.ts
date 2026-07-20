/**
 * Settings (account-level) versioning: git remote config + import.
 *
 * Status / diff / commit-push / branches go through the generic git client
 * (scope "settings", id "account") that drives the shared GitRepositoryTab +
 * GitSyncPanel. Only the two settings-specific concerns live here: the git remote
 * config (a per-instance singleton, not an entity's gitRemoteConfig) and the
 * import (upsert organizations + users + roles; new users land disabled).
 */
import { apiFetch, apiRequest } from '@/lib/api-client'
import { gitError } from '@/lib/api/git'

export interface SettingsGitConfig {
  url: string | null
  branch: string | null
}

export interface SettingsImportReport {
  orgsCreated: number
  orgsUpdated: number
  rolesCreated: number
  rolesUpdated: number
  usersCreated: number
  usersUpdated: number
  warnings: string[]
}

const BASE = '/git/settings/account'

export async function getSettingsGitConfig(): Promise<SettingsGitConfig> {
  return apiRequest<SettingsGitConfig>(`${BASE}/config`)
}

/** Save the settings-scope git remote. The token (if any) is stored per (user,
 *  host) and never returned; an empty url clears the remote. */
export async function setSettingsGitConfig(
  url: string | null,
  branch: string | null,
  authToken?: string | null,
): Promise<SettingsGitConfig> {
  const res = await apiFetch(`/api/v1${BASE}/config`, {
    method: 'PUT',
    body: JSON.stringify({ url: url || null, branch: branch || null, authToken: authToken || undefined }),
  })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

async function postImport(path: string, file?: Blob, branch?: string): Promise<SettingsImportReport> {
  const form = new FormData()
  if (file) form.append('file', file, 'settings.zip')
  if (branch) form.append('branch', branch)
  const res = await apiFetch(`/api/v1${path}`, { method: 'POST', body: form })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

/** Upsert a settings ZIP uploaded by the user (new users land disabled). */
export async function settingsImportFile(file: Blob): Promise<SettingsImportReport> {
  return postImport(`${BASE}/import-file`, file)
}

/** Pull the settings tree from the configured remote and upsert it. */
export async function settingsImportRemote(branch?: string): Promise<SettingsImportReport> {
  return postImport(`${BASE}/import-remote`, undefined, branch)
}
