import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { paths } from '@/lib/paths'
import {
  Database,
  Users,
  Boxes,
  LayoutDashboard,
  FileText,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  AlertCircle,
  CircleDot,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { remarkPlugins, rehypePlugins, urlTransform } from '@/components/editor/ReadmeEditor'
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDashboardStore } from '@/stores/dashboard-store'

interface SummaryOverviewTabProps {
  uid: string
  onNavigateTab: (tab: string) => void
}

const MAX_LIST_ITEMS = 2

const byUpdatedDesc = <T extends { updatedAt?: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())

export function SummaryOverviewTab({ uid, onNavigateTab }: SummaryOverviewTabProps) {
  const { t } = useTranslation()
  const { wsUid } = useResolvedParams()
  const project = useAppStore((s) => s._projectsRaw.find((p) => p.uid === uid))
  const language = useAppStore((s) => s.language)
  const updateProjectTodos = useAppStore((s) => s.updateProjectTodos)

  const handleToggleTodo = (id: string) => {
    const current = project?.todos ?? []
    updateProjectTodos(
      uid,
      current.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)),
    )
  }

  const { getProjectSources } = useDataSourceStore()
  const { getProjectCohorts } = useCohortStore()
  const pipeline = usePipelineStore((s) =>
    s.pipelines.find((p) => p.projectUid === uid),
  )
  const allDashboards = useDashboardStore((s) => s.dashboards)
  const allTabs = useDashboardStore((s) => s.tabs)
  const allWidgets = useDashboardStore((s) => s.widgets)

  // Populate the dashboard store so the overview's dashboard count is accurate even when landing
  // here directly — otherwise it reads 0 until the Lab → Dashboards page loads the data.
  const loadProjectDashboards = useDashboardStore((s) => s.loadProjectDashboards)
  useEffect(() => {
    loadProjectDashboards(uid)
  }, [uid, loadProjectDashboards])

  const dataSources = useMemo(() => getProjectSources(uid).filter((ds) => !ds.isVocabularyReference), [getProjectSources, uid])
  const cohorts = useMemo(() => getProjectCohorts(uid), [getProjectCohorts, uid])

  const dashboards = useMemo(() => {
    const projectDashboards = allDashboards.filter((d) => d.projectUid === uid)
    return projectDashboards.map((dash) => {
      const tabs = allTabs.filter((t) => t.dashboardId === dash.id)
      const tabIds = new Set(tabs.map((t) => t.id))
      const widgetCount = allWidgets.filter((w) => tabIds.has(w.tabId)).length
      return { ...dash, tabCount: tabs.length, widgetCount }
    })
  }, [allDashboards, allTabs, allWidgets, uid])

  const dashboardIds = useMemo(() => dashboards.map((d) => d.id), [dashboards])
  const cohortIds = useMemo(() => cohorts.map((c) => c.id), [cohorts])

  const stats = useMemo(() => {
    const connectedCount = dataSources.filter((ds) => ds.status === 'connected').length
    const errorCount = dataSources.filter((ds) => ds.status === 'error').length
    const cohortsWithResults = cohorts.filter((c) => c.resultCount != null && c.resultCount > 0).length
    const nodes = pipeline?.nodes ?? []
    const successNodes = nodes.filter((n) => n.data.status === 'success').length
    const errorNodes = nodes.filter((n) => n.data.status === 'error').length
    const datasetNodes = nodes.filter((n) => n.data.type === 'dataset').length
    const tabCount = dashboards.reduce((sum, d) => sum + d.tabCount, 0)
    const widgetCount = dashboards.reduce((sum, d) => sum + d.widgetCount, 0)
    const todos = (project?.todos ?? []).map((todo) => ({
      id: todo.id,
      text: localized(todo.text, language),
      done: todo.done,
    }))
    const todosDone = todos.filter((t) => t.done).length

    return {
      connectedCount,
      errorCount,
      cohortsWithResults,
      nodes,
      successNodes,
      errorNodes,
      datasetNodes,
      tabCount,
      widgetCount,
      todos,
      todosDone,
    }
  }, [dataSources, cohorts, pipeline, dashboards, project?.todos, language])

  const readme = localized(project?.readme, language)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden pt-4">
      {/* Readme + To-do previews — top half */}
      <div className="grid min-h-0 basis-1/2 grid-cols-1 gap-4 lg:grid-cols-2">
        <ReadmePreview readme={readme} onViewFull={() => onNavigateTab('readme')} />
        <TodoPreview
          todos={stats.todos}
          done={stats.todosDone}
          onToggle={handleToggleTodo}
          onViewFull={() => onNavigateTab('tasks')}
        />
      </div>

      {/* Stat cards + section details — bottom half */}
      {/* pb-1.5 leaves room for the section cards' shadow-sm so it isn't clipped by the overflow-hidden ancestors */}
      <div className="flex min-h-0 basis-1/2 flex-col gap-4 overflow-hidden pb-1.5">
        {/* Stat Cards */}
        <div className="grid shrink-0 grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={<Database size={18} />}
            iconBg="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
            value={dataSources.length}
            label={t('summary.databases')}
            to={paths.databases(wsUid ?? '', uid)}
            sub={
              dataSources.length > 0
                ? `${stats.connectedCount} ${t('summary.connected')}${stats.errorCount > 0 ? `, ${stats.errorCount} ${t('summary.in_error')}` : ''}`
                : t('summary.no_databases')
            }
          />
          <StatCard
            icon={<Users size={18} />}
            iconBg="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
            value={cohorts.length}
            label={t('summary.cohorts')}
            to={paths.cohorts(wsUid ?? '', uid)}
            sub={
              cohorts.length > 0
                ? `${stats.cohortsWithResults} ${t('summary.with_results')}`
                : t('summary.no_cohorts')
            }
          />
          <StatCard
            icon={<Boxes size={18} />}
            iconBg="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            value={stats.datasetNodes}
            label={t('summary.datasets')}
            to={paths.datasets(wsUid ?? '', uid)}
            sub={
              stats.datasetNodes > 0
                ? `${stats.successNodes} ${t('summary.success')}${stats.errorNodes > 0 ? `, ${stats.errorNodes} ${t('summary.in_error')}` : ''}`
                : t('summary.no_datasets')
            }
          />
          <StatCard
            icon={<LayoutDashboard size={18} />}
            iconBg="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
            value={dashboards.length}
            label={t('summary.dashboards')}
            to={paths.dashboards(wsUid ?? '', uid)}
            sub={
              dashboards.length > 0
                ? `${stats.tabCount} ${t('summary.tabs')}, ${stats.widgetCount} ${t('summary.widgets')}`
                : t('summary.no_dashboards')
            }
          />
        </div>

        {/* Section details */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Data Warehouse */}
          <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex shrink-0 items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-teal-500" />
              <h3 className="text-sm font-semibold">{t('summary.data_warehouse_section')}</h3>
            </div>

            <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-auto">
              {/* Databases list */}
              <SectionList
                title={t('summary.databases')}
                count={dataSources.length}
                viewAllTo={paths.databases(wsUid ?? '', uid)}
                emptyHint={t('summary.no_databases_hint')}
              >
                {byUpdatedDesc(dataSources).slice(0, MAX_LIST_ITEMS).map((ds) => (
                  <ListItem key={ds.id} to={paths.databases(wsUid ?? '', uid)}>
                    <StatusDot status={ds.status} />
                    <span className="flex-1 truncate text-xs">{ds.name}</span>
                    <span className="text-[10px] text-muted-foreground">{ds.sourceType}</span>
                  </ListItem>
                ))}
              </SectionList>

              {/* Cohorts */}
              <SectionList
                title={t('summary.cohorts')}
                count={cohorts.length}
                viewAllTo={paths.cohorts(wsUid ?? '', uid)}
                emptyHint={t('summary.no_cohorts_hint')}
              >
                {byUpdatedDesc(cohorts).slice(0, MAX_LIST_ITEMS).map((c) => (
                  <ListItem key={c.id} to={paths.cohort(wsUid ?? '', uid, c.id, cohortIds)}>
                    <span className="flex-1 truncate text-xs">{c.name}</span>
                    {c.resultCount != null && (
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {c.resultCount.toLocaleString()} {t('summary.results')}
                      </span>
                    )}
                  </ListItem>
                ))}
              </SectionList>
            </div>
          </div>

          {/* Lab */}
          <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex shrink-0 items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              <h3 className="text-sm font-semibold">{t('summary.lab_section')}</h3>
            </div>

            <div className="mt-4 min-h-0 flex-1 space-y-3 overflow-auto">
              {/* Datasets */}
              <SectionList
                title={t('summary.datasets')}
                count={stats.datasetNodes}
                viewAllTo={paths.datasets(wsUid ?? '', uid)}
                emptyHint={t('summary.no_datasets_hint')}
              >
                {stats.nodes
                  .filter((n) => n.data.type === 'dataset')
                  .slice(0, MAX_LIST_ITEMS)
                  .map((n) => (
                    <ListItem key={n.id} to={paths.datasets(wsUid ?? '', uid)}>
                      <PipelineStatusIcon status={n.data.status} />
                      <span className="flex-1 truncate text-xs">
                        {n.data.datasetName || n.data.label}
                      </span>
                      {n.data.rowCount != null && (
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {n.data.rowCount.toLocaleString()} rows
                        </span>
                      )}
                    </ListItem>
                  ))}
              </SectionList>

              {/* Dashboards */}
              <SectionList
                title={t('summary.dashboards')}
                count={dashboards.length}
                viewAllTo={paths.dashboards(wsUid ?? '', uid)}
                emptyHint={t('summary.no_dashboards_hint')}
              >
                {byUpdatedDesc(dashboards).slice(0, MAX_LIST_ITEMS).map((dash) => (
                  <ListItem key={dash.id} to={paths.dashboard(wsUid ?? '', uid, dash.id, dashboardIds)}>
                    <span className="flex-1 truncate text-xs">{localized(dash.name, language)}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {dash.tabCount} {t('summary.tabs')}, {dash.widgetCount} {t('summary.widgets')}
                    </span>
                  </ListItem>
                ))}
              </SectionList>

              {/* Reports */}
              <SectionList
                title={t('summary.reports')}
                count={0}
                viewAllTo={paths.reports(wsUid ?? '', uid)}
                emptyHint={t('summary.no_reports_hint')}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ReadmePreview({ readme, onViewFull }: { readme: string; onViewFull: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('summary.readme')}</h3>
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onViewFull}>
          {t('summary.view_full')}
          <ArrowUpRight size={12} />
        </Button>
      </div>
      <div className="relative mt-3 min-h-0 flex-1 overflow-hidden">
        {readme.trim() ? (
          <>
            <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:!mt-0">
              <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform}>
                {readme}
              </ReactMarkdown>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('summary.readme_empty')}</p>
        )}
      </div>
    </div>
  )
}

function TodoPreview({
  todos,
  done,
  onToggle,
  onViewFull,
}: {
  todos: { id: string; text: string; done: boolean }[]
  done: number
  onToggle: (id: string) => void
  onViewFull: () => void
}) {
  const { t } = useTranslation()
  const pct = todos.length > 0 ? Math.round((done / todos.length) * 100) : 0
  return (
    <div className="flex min-h-0 flex-col rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle2 size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('summary.todo')}</h3>
          {todos.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {done}/{todos.length} ({pct}%)
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onViewFull}>
          {t('summary.view_full')}
          <ArrowUpRight size={12} />
        </Button>
      </div>
      {todos.length > 0 && (
        <div className="mt-3 h-1.5 shrink-0 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-hidden">
        {todos.length > 0 ? (
          todos.map((todo) => (
            <div key={todo.id} className="flex items-center gap-2">
              <button
                onClick={() => onToggle(todo.id)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {todo.done ? (
                  <CheckCircle2 size={14} className="text-primary" />
                ) : (
                  <Circle size={14} />
                )}
              </button>
              <span
                className={`truncate text-xs ${todo.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}
              >
                {todo.text}
              </span>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">{t('summary.todo_empty')}</p>
        )}
      </div>
    </div>
  )
}

function SectionList({
  title,
  count,
  viewAllTo,
  emptyHint,
  children,
}: {
  title: string
  count: number
  viewAllTo: string
  emptyHint: string
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {title} ({count})
        </span>
        <Link
          to={viewAllTo}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t('summary.view_all')}
          <ArrowRight size={10} />
        </Link>
      </div>
      {count > 0 ? (
        <div className="mt-1.5 space-y-1">{children}</div>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">{emptyHint}</p>
      )}
    </div>
  )
}

function ListItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 transition-colors hover:bg-muted"
    >
      {children}
    </Link>
  )
}

function StatCard({
  icon,
  iconBg,
  value,
  label,
  sub,
  to,
}: {
  icon: React.ReactNode
  iconBg: string
  value: number
  label: string
  sub: string
  to?: string
}) {
  const content = (
    <>
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconBg}`}>
          {icon}
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{sub}</p>
    </>
  )
  const className = 'rounded-xl border bg-card p-4 shadow-sm'
  if (to) {
    return (
      <Link to={to} className={`${className} block transition-colors hover:bg-accent/50`}>
        {content}
      </Link>
    )
  }
  return <div className={className}>{content}</div>
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'error'
        ? 'bg-red-500'
        : status === 'configuring'
          ? 'bg-amber-500'
          : 'bg-gray-400'

  return <div className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
}

function PipelineStatusIcon({ status }: { status: string }) {
  if (status === 'success') return <CheckCircle2 size={12} className="shrink-0 text-emerald-500" />
  if (status === 'error') return <AlertCircle size={12} className="shrink-0 text-red-500" />
  return <CircleDot size={12} className="shrink-0 text-muted-foreground" />
}
