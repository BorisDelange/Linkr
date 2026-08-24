import { useCallback } from 'react'
import JSZip from 'jszip'
import { useDataSourceStore } from '@/stores/data-source-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildDataSourceFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { AddDatabaseDialog } from './AddDatabaseDialog'
import type { DataSource, GitRemoteConfig } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

export interface DatabaseActions {
  onDelete: (id: string) => Promise<void> | void
  onExport: (item: DataSource) => void
  getGitRemote: (item: DataSource) => GitRemoteConfig | null
  onSaveGitRemote: (item: DataSource, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: DataSource; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<DataSource>
}

/**
 * Shared per-item actions for a database (delete / export / git link / readme /
 * licence / edit). Used by both the list-page cards and the header badge menu,
 * so the two cannot drift.
 *
 * `exportSupportsIncludeData` is false and stays false: a database export
 * carries documentation and metadata, never rows — see buildDataSourceFolder.
 */
export function useDatabaseActions(): DatabaseActions {
  const updateDataSource = useDataSourceStore((s) => s.updateDataSource)
  const removeDataSource = useDataSourceStore((s) => s.removeDataSource)

  const onExport = useCallback(async (source: DataSource) => {
    const zip = new JSZip()
    await buildDataSourceFolder(zip, '', source, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${source.entityId || slugify(localized(source.name, 'en'))}.zip`)
  }, [])

  const onSaveGitRemote = useCallback(
    async (source: DataSource, config: GitRemoteConfig | null) => {
      await updateDataSource(source.id, { gitRemoteConfig: config ?? undefined })
    },
    [updateDataSource],
  )

  return {
    onDelete: (id) => removeDataSource(id),
    onExport,
    getGitRemote: (source) => source.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <AddDatabaseDialog open onOpenChange={onOpenChange} editingSource={item} />
    ),
    deleteConfirmTitleKey: 'databases.remove_confirm_title',
    deleteConfirmDescriptionKey: 'databases.remove_confirm_description',
    docs: {
      getReadme: (e) => e.readme,
      onSaveReadme: (e, readme) => updateDataSource(e.id, { readme }),
      getLicense: (e) => e.license ?? null,
      onSaveLicense: (e, license) => updateDataSource(e.id, { license: license ?? undefined }),
      attachmentOwnerType: 'data-source',
      getWorkspaceId: (e) => e.workspaceId,
    },
  }
}
