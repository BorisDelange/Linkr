import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams, useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { Plus, FolderOpen, Search, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CreateProjectDialog } from './CreateProjectDialog'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'

export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { wsUid } = useParams()
  const { _projectsRaw, projects, getWorkspaceProjects, openProject } = useAppStore()
  const { activeWorkspaceId } = useWorkspaceStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

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
                  className="cursor-pointer transition-colors hover:bg-accent"
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
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0 ${getStatusClasses(status)}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
                        {t(`project_settings.status_${status}`)}
                      </span>
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
    </div>
  )
}
