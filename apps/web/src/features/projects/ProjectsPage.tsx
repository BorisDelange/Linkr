import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams, useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { Plus, FolderOpen, Search, Upload, MoreHorizontal, Download, Copy, History, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { CreateProjectDialog } from './CreateProjectDialog'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'

export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { wsUid } = useParams()
  const { _projectsRaw, projects, getWorkspaceProjects, openProject, deleteProject } = useAppStore()
  const { activeWorkspaceId } = useWorkspaceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ uid: string; name: string } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      setDialogOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Filter projects by workspace if we're inside one
  const displayProjects = wsUid ? getWorkspaceProjects(wsUid) : projects

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return displayProjects
    const words = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return displayProjects.filter((p) => {
      const text = `${p.name} ${p.description ?? ''}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
  }, [displayProjects, searchQuery])

  const handleOpenProject = (uid: string, name: string) => {
    openProject(uid, name)
    if (wsUid) {
      navigate(`/workspaces/${wsUid}/projects/${uid}/summary`)
    } else {
      navigate(`/workspaces/${activeWorkspaceId}/projects/${uid}/summary`)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    await deleteProject(deleteTarget.uid)
    setDeleteTarget(null)
    setDeleteConfirm('')
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('projects.title')}
          </h1>
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
              {t('projects.create')}
            </Button>
          </div>
        </div>

        {displayProjects.length > 0 && (
          <div className="relative mt-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('projects.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        {displayProjects.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <FolderOpen size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('projects.no_projects')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('projects.no_projects_description')}
              </p>
              <Button onClick={() => setDialogOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('projects.create')}
              </Button>
            </div>
          </Card>
        ) : filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <Search size={32} className="text-muted-foreground/30" />
            <p className="mt-2 text-sm text-muted-foreground">{t('projects.no_results')}</p>
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {filteredProjects.map((project) => {
              const raw = _projectsRaw.find((p) => p.uid === project.uid)
              const badges = raw?.badges ?? []
              const status = raw?.status ?? 'active'
              return (
                <Card
                  key={project.uid}
                  className="relative cursor-pointer transition-colors hover:bg-accent"
                  onClick={() => handleOpenProject(project.uid, project.name)}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          <FolderOpen size={16} className="text-primary" />
                        </div>
                        <span className="truncate text-sm font-medium text-card-foreground">{project.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                          {t(`project_settings.status_${status}`)}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}>
                              <MoreHorizontal size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem disabled>
                              <Download size={14} />
                              {t('common.export')}
                              <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled>
                              <Copy size={14} />
                              {t('common.duplicate')}
                              <span className="ml-auto text-[10px] text-muted-foreground">{t('common.coming_soon')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled>
                              <History size={14} />
                              {t('common.history')}
                              <span className="ml-auto text-[10px] text-muted-foreground">{t('common.server_only')}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget({ uid: project.uid, name: project.name }) }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 size={14} />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    {project.description && (
                      <p className="mt-2 truncate text-xs text-muted-foreground" title={project.description}>
                        {project.description}
                      </p>
                    )}
                    {badges.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {badges.map((badge) => (
                          <span
                            key={badge.id}
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${getBadgeClasses(badge.color)}`}
                            style={getBadgeStyle(badge.color)}
                          >
                            {badge.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} workspaceId={wsUid} />

      {/* Delete project confirmation */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirm('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('project_settings.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('project_settings.delete_confirm_description')}</p>
                <p className="text-sm">
                  {t('project_settings.delete_confirm_type')}{' '}
                  <span className="font-semibold text-foreground">{deleteTarget?.name}</span>
                </p>
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={deleteTarget?.name}
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDeleteTarget(null); setDeleteConfirm('') }}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteConfirm !== deleteTarget?.name}
              className="!bg-destructive !text-white hover:!bg-destructive/90 disabled:!opacity-50"
              onClick={handleDelete}
            >
              {t('project_settings.delete_project')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
