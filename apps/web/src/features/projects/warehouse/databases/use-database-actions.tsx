import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { isServerMode } from '@/lib/api-client'
import { createdData } from '@/lib/cohort-derive'
import JSZip from 'jszip'
import { useDataSourceStore } from '@/stores/data-source-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildDataSourceFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { AddDatabaseDialog } from './AddDatabaseDialog'
import type { DataSource, GitRemoteConfig } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

export interface DatabaseActions {
  onDelete: (id: string, deleteData?: boolean) => Promise<void> | void
  /** The delete confirmation's "also remove its file / SQL schema" choice. */
  deleteOption: (item: DataSource) => string | null
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
  const { t } = useTranslation()
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
    onDelete: (id, deleteData) => removeDataSource(id, { deleteData }),
    // Only what Linkr created: a connection someone added points at data that
    // is not Linkr's to remove. Server mode, where that data lives.
    deleteOption: (source) => {
      const created = isServerMode() ? createdData(source) : null
      if (!created) return null
      return created.kind === 'file'
        ? t('databases.delete_created_file', { path: created.path })
        : t('databases.delete_created_schema', { schema: created.schema })
    },
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
