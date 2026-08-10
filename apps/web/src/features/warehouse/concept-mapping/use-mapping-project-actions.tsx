import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { getStorage } from '@/lib/storage'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import type { GitRemoteConfig, MappingProject } from '@/types'
import type { EntityDocsAccessors } from '@/components/ui/entity-actions-menu'

export interface MappingProjectActions {
  onDelete: (id: string) => Promise<void>
  /** Export navigates to the project's own Export tab instead of downloading a ZIP. */
  onExportOverride: (item: MappingProject) => void
  /** Versioning navigates to the project's own Versioning tab instead of a dialog. */
  onVersioningOverride: (item: MappingProject) => void
  getGitRemote: (item: MappingProject) => GitRemoteConfig | null
  onSaveGitRemote: (item: MappingProject, config: GitRemoteConfig | null) => Promise<void>
  exportSupportsIncludeData: boolean
  renderEditDialog: (props: { item: MappingProject; onOpenChange: (open: boolean) => void }) => React.ReactNode
  deleteConfirmTitleKey: string
  deleteConfirmDescriptionKey: string
  docs: EntityDocsAccessors<MappingProject>
}

/**
 * Shared per-item actions config for a mapping project (delete / export / git
 * link / edit). Used by both the list page cards and the header badge menu so
 * the two stay behaviourally identical.
 */
export function useMappingProjectActions(): MappingProjectActions {
  const navigate = useNavigate()
  const updateMappingProject = useConceptMappingStore((s) => s.updateMappingProject)
  const deleteMappingProject = useConceptMappingStore((s) => s.deleteMappingProject)
  const loadMappingProjects = useConceptMappingStore((s) => s.loadMappingProjects)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  const onExportOverride = useCallback((project: MappingProject) => {
    const wsId = activeWorkspaceId ?? project.workspaceId
    navigate(`/workspaces/${wsId}/warehouse/concept-mapping/${project.id}?tab=export`)
  }, [navigate, activeWorkspaceId])

  const onVersioningOverride = useCallback((project: MappingProject) => {
    const wsId = activeWorkspaceId ?? project.workspaceId
    navigate(`/workspaces/${wsId}/warehouse/concept-mapping/${project.id}?tab=versioning`)
  }, [navigate, activeWorkspaceId])

  const onSaveGitRemote = useCallback(async (p: MappingProject, config: GitRemoteConfig | null) => {
    await getStorage().mappingProjects.update(p.id, { gitRemoteConfig: config ?? undefined })
    await loadMappingProjects()
  }, [loadMappingProjects])

  return {
    onDelete: (id) => deleteMappingProject(id),
    onExportOverride,
    onVersioningOverride,
    getGitRemote: (p) => p.gitRemoteConfig ?? null,
    onSaveGitRemote,
    exportSupportsIncludeData: false,
    renderEditDialog: ({ item, onOpenChange }) => (
      <CreateMappingProjectDialog open onOpenChange={onOpenChange} editingProject={item} />
    ),
    deleteConfirmTitleKey: 'concept_mapping.delete_confirm_title',
    deleteConfirmDescriptionKey: 'concept_mapping.delete_confirm_description',
    docs: {
      getReadme: (e) => e.readme,
      onSaveReadme: (e, readme) => updateMappingProject(e.id, { readme }),
      getLicense: (e) => e.license ?? null,
      onSaveLicense: (e, license) => updateMappingProject(e.id, { license: license ?? undefined }),
      attachmentOwnerType: 'mapping-project',
      getWorkspaceId: (e) => e.workspaceId,
    },
  }
}
