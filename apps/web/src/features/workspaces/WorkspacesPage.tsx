import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { Plus, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'

export function WorkspacesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { workspaces, _workspacesRaw, openWorkspace } = useWorkspaceStore()
  const { getWorkspaceProjects } = useAppStore()
  const [dialogOpen, setDialogOpen] = useState(false)

  const handleOpenWorkspace = (id: string, name: string) => {
    openWorkspace(id, name)
    navigate(`/workspaces/${id}/home`)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">
            {t('workspaces.title')}
          </h1>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            {t('workspaces.create')}
          </Button>
        </div>

        {workspaces.length === 0 ? (
          <Card className="mt-6">
            <div className="flex flex-col items-center py-12">
              <Building2 size={40} className="text-muted-foreground" />
              <p className="mt-4 text-sm font-medium text-foreground">
                {t('workspaces.no_workspaces')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('workspaces.no_workspaces_description')}
              </p>
              <Button onClick={() => setDialogOpen(true)} className="mt-4 gap-2">
                <Plus size={16} />
                {t('workspaces.create')}
              </Button>
            </div>
          </Card>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {workspaces.map((ws) => {
              const projectCount = getWorkspaceProjects(ws.id).length
              const raw = _workspacesRaw.find((w) => w.id === ws.id)
              const badges = raw?.badges ?? []
              return (
                <Card
                  key={ws.id}
                  className="cursor-pointer transition-colors hover:bg-accent"
                  onClick={() => handleOpenWorkspace(ws.id, ws.name)}
                >
                  <div className="p-4">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Building2 size={16} className="text-primary" />
                      </div>
                      <div className="min-w-0">
                        <span className="block truncate text-sm font-medium text-card-foreground">
                          {ws.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {ws.organizationName}
                        </span>
                      </div>
                    </div>
                    {ws.description && (
                      <p className="mt-2 truncate text-xs text-muted-foreground" title={ws.description}>
                        {ws.description}
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
                    <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span>
                        {projectCount} {projectCount === 1 ? t('workspaces.project_count_one') : t('workspaces.project_count_other')}
                      </span>
                      <span>{ws.createdAt}</span>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <CreateWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  )
}
