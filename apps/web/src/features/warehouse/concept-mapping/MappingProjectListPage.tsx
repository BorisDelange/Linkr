import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowRightLeft, Plus, Trash2, Pencil, Download, History, Database, MoreHorizontal, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useConceptMappingStore } from '@/stores/concept-mapping-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { CreateMappingProjectDialog } from './CreateMappingProjectDialog'
import type { MappingProject } from '@/types'

export function MappingProjectListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { activeWorkspaceId } = useWorkspaceStore()
  const { mappingProjectsLoaded, loadMappingProjects, getWorkspaceProjects, deleteMappingProject } = useConceptMappingStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<MappingProject | null>(null)
  const [projectToEdit, setProjectToEdit] = useState<MappingProject | null>(null)

  useEffect(() => {
    if (!mappingProjectsLoaded) loadMappingProjects()
  }, [mappingProjectsLoaded, loadMappingProjects])

  const projects = activeWorkspaceId ? getWorkspaceProjects(activeWorkspaceId) : []

  const getSourceName = (sourceId: string) =>
    dataSources.find((ds) => ds.id === sourceId)?.name ?? t('concept_mapping.unknown_source')

  const handleCreated = (projectId: string) => {
    navigate(projectId)
  }

  const handleDelete = async () => {
    if (projectToDelete) {
      await deleteMappingProject(projectToDelete.id)
      setProjectToDelete(null)
    }
  }

  const getProgress = (project: MappingProject) => {
    if (!project.stats || project.stats.totalSourceConcepts === 0) return 0
    return Math.round((project.stats.mappedCount / project.stats.totalSourceConcepts) * 100)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t('concept_mapping.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('concept_mapping.description')}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0}>
                  <Button variant="outline" size="sm" disabled className="gap-1 text-xs">
                    <Upload size={14} />
                    {t('common.import')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{t('common.coming_soon')}</TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={() => setDialogOpen(true)} className="gap-1 text-xs">
              <Plus size={14} />
              {t('concept_mapping.new_project')}
            </Button>
          </div>
        </div>

        {projects.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <ArrowRightLeft size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('concept_mapping.no_projects')}
              </p>
              <p className="mt-1 max-w-sm text-center text-xs text-muted-foreground">
                {t('concept_mapping.no_projects_description')}
              </p>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3">
            {projects.map((project) => {
              const progress = getProgress(project)
              return (
                <Card
                  key={project.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(project.id)}
                >
                  <div className="flex items-start gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10">
                      <ArrowRightLeft size={20} className="text-violet-500" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {project.name}
                        </span>
                        {project.stats && (
                          <Badge variant="secondary" className="text-[10px]">
                            {project.stats.approvedCount}/{project.stats.totalSourceConcepts}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Database size={12} />
                        <span>{getSourceName(project.dataSourceId)}</span>
                      </div>
                      {project.stats && project.stats.totalSourceConcepts > 0 && (
                        <div className="mt-2">
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-green-500 transition-all"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                            <span>{t('concept_mapping.mapped_count', { count: project.stats.mappedCount })}</span>
                            <span>{progress}%</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setProjectToEdit(project) }}>
                          <Pencil size={14} />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <Download size={14} />
                          {t('common.export')}
                          <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled>
                          <History size={14} />
                          {t('common.history')}
                          <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); setProjectToDelete(project) }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 size={14} />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateMappingProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={handleCreated}
      />

      <CreateMappingProjectDialog
        open={!!projectToEdit}
        onOpenChange={(open) => { if (!open) setProjectToEdit(null) }}
        editingProject={projectToEdit}
      />

      <AlertDialog open={!!projectToDelete} onOpenChange={(open) => { if (!open) setProjectToDelete(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('concept_mapping.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('concept_mapping.delete_confirm_description', { name: projectToDelete?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
