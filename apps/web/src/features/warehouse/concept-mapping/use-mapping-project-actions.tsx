import { useCallback } from 'react'
import JSZip from 'jszip'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { localized } from '@/lib/localized'
import { getStorage } from '@/lib/storage'
import { downloadBlob, slugify } from '@/lib/entity-io'
import { buildMappingProjectFolder } from '@/lib/concept-mapping/export'
import { queryDataSource } from '@/lib/duckdb/engine'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import type { GitRemoteConfig, MappingProject } from '@/types'

export interface MappingProjectActions {
  onDelete: (id: string) => Promise<void>
  onExport: (item: MappingProject) => void
  getGitRemote: (item: MappingProject) => GitRemoteConfig | null
  onSaveGitRemote: (item: MappingProject, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: MappingProject; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
}

/**
 * Shared per-item actions config for a mapping project (delete / export / git
 * link / edit). Used by both the list page cards and the header badge menu so
 * the two stay behaviourally identical.
 */
export function useMappingProjectActions(): MappingProjectActions {
  const deleteMappingProject = useConceptMappingStore((s) => s.deleteMappingProject)
  const loadMappingProjects = useConceptMappingStore((s) => s.loadMappingProjects)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)

  const onExport = useCallback(async (project: MappingProject) => {
    const zip = new JSZip()
    await buildMappingProjectFolder(zip, '', project, getStorage(), {
      queryDataSource,
      ensureMounted,
      dataSources,
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${slugify(localized(project.name, 'en'))}.zip`)
  }, [dataSources, ensureMounted])

  const onSaveGitRemote = useCallback(async (p: MappingProject, config: GitRemoteConfig | null) => {
    await getStorage().mappingProjects.update(p.id, { gitRemoteConfig: config ?? undefined })
    await loadMappingProjects()
  }, [loadMappingProjects])

  return {
    onDelete: (id) => deleteMappingProject(id),
    onExport,
    getGitRemote: (p) => p.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateMappingProjectDialog open onOpenChange={onOpenChange} editingProject={item} />
    ),
    deleteConfirmTitleKey: 'concept_mapping.delete_confirm_title',
    deleteConfirmDescriptionKey: 'concept_mapping.delete_confirm_description',
  }
}
