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

/** Which families to include in a pull/import (null count = family absent from remote). */
export interface SettingsFamilySelection {
  organizations: boolean
  users: boolean
  roles: boolean
}

export interface SettingsPullPreview {
  organizations: number | null
  users: number | null
  roles: number | null
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

/** Upsert a settings ZIP uploaded by the user (new users land disabled). */
export async function settingsImportFile(file: Blob): Promise<SettingsImportReport> {
  const form = new FormData()
  form.append('file', file, 'settings.zip')
  const res = await apiFetch(`/api/v1${BASE}/import-file`, { method: 'POST', body: form })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

/** How many organizations/users/roles the remote settings tree holds — drives the
 *  pull dialog's per-family choice. */
export async function settingsPullPreview(branch?: string): Promise<SettingsPullPreview> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : ''
  return apiRequest<SettingsPullPreview>(`${BASE}/pull-preview${qs}`)
}

/** Pull from the configured remote and upsert the chosen families. */
export async function settingsImportRemote(
  selection: SettingsFamilySelection,
  branch?: string,
): Promise<SettingsImportReport> {
  const form = new FormData()
  if (branch) form.append('branch', branch)
  form.append('include_orgs', String(selection.organizations))
  form.append('include_users', String(selection.users))
  form.append('include_roles', String(selection.roles))
  const res = await apiFetch(`/api/v1${BASE}/import-remote`, { method: 'POST', body: form })
  if (!res.ok) throw await gitError(res)
  return res.json()
}

/** Download the settings export ZIP (organizations + users + roles, no passwords). */
export async function downloadSettingsZip(): Promise<Blob> {
  const res = await apiFetch(`/api/v1${BASE}/export`)
  if (!res.ok) throw await gitError(res)
  return res.blob()
}
