import { useCallback } from 'react'
import JSZip from 'jszip'
import { buildDqProfileFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { useDqProfileStore } from '@/stores/dq-profile-store'
import { CreateDqProfileDialog } from './CreateDqProfileDialog'
import type { DqProfile, GitRemoteConfig } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

export interface DqProfileActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: DqProfile) => void
  getGitRemote: (item: DqProfile) => GitRemoteConfig | null
  onSaveGitRemote: (item: DqProfile, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: DqProfile; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<DqProfile>
}

/**
 * Per-item actions of a quality profile (delete / export / edit / docs / git),
 * shared by the list page cards and the header badge menu so the two behave
 * the same.
 */
export function useDqProfileActions(): DqProfileActions {
  const updateProfile = useDqProfileStore((s) => s.updateProfile)
  const deleteProfile = useDqProfileStore((s) => s.deleteProfile)

  // The same builder the git sync pushes, so a ZIP and a repo hold one tree.
  const onExport = useCallback(async (profile: DqProfile) => {
    const zip = new JSZip()
    await buildDqProfileFolder(zip, '', profile, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(profile.name, 'en'))}.zip`)
  }, [])

  return {
    onDelete: (id) => deleteProfile(id),
    onExport,
    getGitRemote: (p) => p.gitRemoteConfig ?? null,
    onSaveGitRemote: (p, config) => updateProfile(p.id, { gitRemoteConfig: config ?? undefined }),
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateDqProfileDialog open onOpenChange={onOpenChange} editingProfile={item} />
    ),
    deleteConfirmTitleKey: 'data_quality.delete_profile_title',
    deleteConfirmDescriptionKey: 'data_quality.delete_profile_description',
    docs: {
      getReadme: (e) => e.readme,
      onSaveReadme: (e, readme) => updateProfile(e.id, { readme }),
      getLicense: (e) => e.license ?? null,
      onSaveLicense: (e, license) => updateProfile(e.id, { license: license ?? undefined }),
      attachmentOwnerType: 'dq-profile',
      getWorkspaceId: (e) => e.workspaceId,
    },
  }
}
