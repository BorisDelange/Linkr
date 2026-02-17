import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  Building2,
  ArrowRight,
  Settings,
  Plus,
  Store,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useWorkspaceStore } from '@/stores/workspace-store'

const quickActions = [
  {
    icon: Building2,
    labelKey: 'home.action_workspaces',
    descKey: 'home.action_workspaces_description',
    color: 'bg-amber-500/10 text-amber-600',
    path: '/workspaces',
  },
  {
    icon: Store,
    labelKey: 'home.action_catalog',
    descKey: 'home.action_catalog_description',
    color: 'bg-violet-500/10 text-violet-600',
    path: '/catalog',
  },
  {
    icon: Settings,
    labelKey: 'home.action_settings',
    descKey: 'home.action_settings_description',
    color: 'bg-slate-500/10 text-slate-600',
    path: '/settings',
  },
]

const MAX_RECENT = 4

export function HomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { workspaces, openWorkspace } = useWorkspaceStore()

  const recentWorkspaces = [...workspaces]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_RECENT)

  const handleOpenWorkspace = (id: string, name: string) => {
    openWorkspace(id, name)
    navigate(`/workspaces/${id}/home`)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-8 py-12">
        {/* Hero */}
        <div className="text-center">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-foreground">
            {t('home.hero_title')}{' '}
            <span className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-transparent">
              {t('home.hero_title_highlight')}
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            {t('home.hero_description')}
          </p>
        </div>

        {/* Recent workspaces */}
        <div className="mt-12">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              {t('home.recent_workspaces')}
            </h2>
            {workspaces.length > 0 && (
              <Button
                variant="link"
                size="sm"
                onClick={() => navigate('/workspaces')}
                className="h-auto gap-1 p-0 text-xs"
              >
                {t('home.view_all_workspaces')}
                <ArrowRight size={12} />
              </Button>
            )}
          </div>

          {recentWorkspaces.length > 0 ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {recentWorkspaces.map((ws) => (
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
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="mt-3">
              <CardContent className="flex flex-col items-center justify-center py-10">
                <Building2
                  size={32}
                  className="text-muted-foreground"
                />
                <p className="mt-3 text-sm font-medium text-muted-foreground">
                  {t('home.no_recent_workspaces')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  {t('home.no_recent_workspaces_description')}
                </p>
                <Button onClick={() => navigate('/workspaces')} className="mt-4 gap-2">
                  <Plus size={16} />
                  {t('home.create_workspace')}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Quick actions */}
        <div className="mt-12">
          <h2 className="text-sm font-semibold text-foreground">
            {t('home.quick_actions')}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {quickActions.map((action) => (
              <button
                key={action.labelKey}
                onClick={() => navigate(action.path)}
                className="group flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-all hover:bg-accent hover:shadow-md"
              >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-110 ${action.color}`}>
                  <action.icon size={16} />
                </div>
                <div>
                  <p className="text-[13px] font-medium text-card-foreground">
                    {t(action.labelKey)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t(action.descKey)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
