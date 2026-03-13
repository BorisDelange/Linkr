import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { Calendar, User } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getBadgeClasses, getBadgeStyle, getStatusClasses, getStatusDotClass } from './ProjectSettingsPage'
import { SummaryOverviewTab } from './summary/SummaryOverviewTab'
import { SummaryReadmeTab } from './summary/SummaryReadmeTab'

import { SummaryTasksTab } from './summary/SummaryTasksTab'

export function SummaryPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const { _projectsRaw, user, language } = useAppStore()

  const project = _projectsRaw.find((p) => p.uid === uid)

  if (!project) return null

  const projectName =
    project.name[language] ?? Object.values(project.name)[0]
  const projectDesc =
    project.description[language] ?? Object.values(project.description)[0]
  const badges = project.badges ?? []
  const status = project.status ?? 'active'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Project header */}
      <div className="shrink-0 px-6 pt-6 pb-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">{projectName}</h1>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-medium ${getStatusClasses(status)}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${getStatusDotClass(status)}`} />
            {t(`project_settings.status_${status}`)}
          </span>
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
        {projectDesc && (
          <p className="mt-1 text-sm text-muted-foreground">{projectDesc}</p>
        )}
        <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1">
            <Calendar size={11} />
            <span>
              {t('summary.created_at')}: {project.createdAt.split('T')[0]}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <User size={11} />
            <span>
              {t('summary.owner')}: {user?.username ?? 'admin'}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col px-6 pb-6">
        <TabsList variant="line" className="shrink-0">
          <TabsTrigger value="overview">{t('summary.tab_overview')}</TabsTrigger>
          <TabsTrigger value="readme">{t('summary.tab_readme')}</TabsTrigger>

          <TabsTrigger value="tasks">{t('summary.tab_tasks')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <SummaryOverviewTab uid={uid!} />
        </TabsContent>
        <TabsContent value="readme" className="min-h-0 flex-1 overflow-hidden">
          <SummaryReadmeTab uid={uid!} />
        </TabsContent>

        <TabsContent value="tasks" className="min-h-0 flex-1 overflow-hidden">
          <SummaryTasksTab uid={uid!} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
