import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import JSZip from 'jszip'
import { useEtlStore } from '@/stores/etl-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { buildEtlPipelineFolder, downloadBlob, slugify } from '@/lib/entity-io'
import { CreateEtlDialog } from './CreateEtlDialog'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'
import type { GitRemoteConfig, EtlPipeline } from '@/types'

export interface EtlActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: EtlPipeline) => void
  getGitRemote: (item: EtlPipeline) => GitRemoteConfig | null
  onSaveGitRemote: (item: EtlPipeline, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  /** The pipeline owns a Versioning tab, so the menu goes there, not to a dialog. */
  onVersioningOverride: (item: EtlPipeline) => void
  renderEditDialog: (props: { item: EtlPipeline; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<EtlPipeline>
}

/**
 * Shared per-item actions config for an ETL pipeline (delete / export / git
 * link / edit). Used by both the list page cards and the header badge menu so
 * the two stay behaviourally identical.
 */
export function useEtlActions(): EtlActions {
  const deletePipeline = useEtlStore((s) => s.deletePipeline)
  const loadEtlPipelines = useEtlStore((s) => s.loadEtlPipelines)
  const updatePipeline = useEtlStore((s) => s.updatePipeline)
  const navigate = useNavigate()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const onVersioningOverride = useCallback((p: EtlPipeline) => {
    const wsId = activeWorkspaceId ?? p.workspaceId
    navigate(`/workspaces/${wsId}/warehouse/etl/${p.id}?tab=versioning`)
  }, [navigate, activeWorkspaceId])

  const onExport = useCallback(async (pipeline: EtlPipeline) => {
    const zip = new JSZip()
    await buildEtlPipelineFolder(zip, '', pipeline, getStorage())
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(pipeline.name, 'en'))}.zip`)
  }, [])

  const onSaveGitRemote = useCallback(async (p: EtlPipeline, config: GitRemoteConfig | null) => {
    await getStorage().etlPipelines.update(p.id, { gitRemoteConfig: config ?? undefined })
    await loadEtlPipelines()
  }, [loadEtlPipelines])

  return {
    onDelete: (id) => deletePipeline(id),
    onExport,
    getGitRemote: (p) => p.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    onVersioningOverride,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateEtlDialog open onOpenChange={onOpenChange} editingPipeline={item} />
    ),
    deleteConfirmTitleKey: 'etl.delete_confirm_title',
    deleteConfirmDescriptionKey: 'etl.delete_confirm_description',
    docs: {
      getReadme: (p) => p.readme,
      onSaveReadme: (p, readme) => updatePipeline(p.id, { readme }),
      getLicense: (p) => p.license ?? null,
      onSaveLicense: (p, license) => updatePipeline(p.id, { license: license ?? undefined }),
      attachmentOwnerType: 'etl-pipeline',
      getWorkspaceId: (p) => p.workspaceId,
    },
  }
}
