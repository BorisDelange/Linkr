import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Database,
  Users,
  GitBranch,
  LayoutDashboard,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  CircleDot,
} from 'lucide-react'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDashboardStore } from '@/stores/dashboard-store'

interface SummaryOverviewTabProps {
  uid: string
}

export function SummaryOverviewTab({ uid }: SummaryOverviewTabProps) {
  const { t } = useTranslation()
  const project = useAppStore((s) => s._projectsRaw.find((p) => p.uid === uid))

  const { getProjectSources } = useDataSourceStore()
  const { getProjectCohorts } = useCohortStore()
  const pipeline = usePipelineStore((s) =>
    s.pipelines.find((p) => p.projectUid === uid),
  )
  const allTabs = useDashboardStore((s) => s.tabs)

  const dataSources = useMemo(() => getProjectSources(uid), [getProjectSources, uid])
  const cohorts = useMemo(() => getProjectCohorts(uid), [getProjectCohorts, uid])
  const dashTabs = useMemo(() => allTabs.filter((t) => t.projectUid === uid), [allTabs, uid])
  const allWidgets = useDashboardStore((s) => s.widgets)

  const stats = useMemo(() => {
    const connectedCount = dataSources.filter((ds) => ds.status === 'connected').length
    const errorCount = dataSources.filter((ds) => ds.status === 'error').length
    const cohortsWithResults = cohorts.filter((c) => c.resultCount != null && c.resultCount > 0).length
    const nodes = pipeline?.nodes ?? []
    const successNodes = nodes.filter((n) => n.data.status === 'success').length
    const errorNodes = nodes.filter((n) => n.data.status === 'error').length
    const datasetNodes = nodes.filter((n) => n.data.type === 'dataset').length
    const tabIds = new Set(dashTabs.map((t) => t.id))
    const widgetCount = allWidgets.filter((w) => tabIds.has(w.tabId)).length
    const todos = project?.todos ?? []
    const todosDone = todos.filter((t) => t.done).length

    return {
      connectedCount,
      errorCount,
      cohortsWithResults,
      nodes,
      successNodes,
      errorNodes,
      datasetNodes,
      widgetCount,
      todos,
      todosDone,
    }
  }, [dataSources, cohorts, pipeline, dashTabs, allWidgets, project?.todos])

  return (
    <div className="space-y-6 pt-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={<Database size={18} />}
          iconBg="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
          value={dataSources.length}
          label={t('summary.databases')}
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
          sub={
            cohorts.length > 0
              ? `${stats.cohortsWithResults} ${t('summary.with_results')}`
              : t('summary.no_cohorts')
          }
        />
        <StatCard
          icon={<GitBranch size={18} />}
          iconBg="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
          value={stats.nodes.length}
          label={t('summary.pipeline_nodes')}
          sub={
            stats.nodes.length > 0
              ? `${stats.successNodes} ${t('summary.success')}${stats.errorNodes > 0 ? `, ${stats.errorNodes} ${t('summary.in_error')}` : ''}`
              : t('summary.no_pipeline')
          }
        />
        <StatCard
          icon={<LayoutDashboard size={18} />}
          iconBg="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
          value={dashTabs.length}
          label={t('summary.dashboards')}
          sub={
            dashTabs.length > 0
              ? `${stats.widgetCount} ${t('summary.widgets')}`
              : t('summary.no_dashboards')
          }
        />
      </div>

      {/* Section details */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Data Warehouse */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-teal-500" />
            <h3 className="text-sm font-semibold">{t('summary.data_warehouse_section')}</h3>
          </div>

          <div className="mt-4 space-y-3">
            {/* Databases list */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('summary.databases')} ({dataSources.length})
                </span>
                <Link
                  to={`/projects/${uid}/warehouse/databases`}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('summary.view_all')}
                  <ArrowRight size={10} />
                </Link>
              </div>
              {dataSources.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {dataSources.map((ds) => (
                    <div
                      key={ds.id}
                      className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5"
                    >
                      <StatusDot status={ds.status} />
                      <span className="flex-1 truncate text-xs">{ds.name}</span>
                      <span className="text-[10px] text-muted-foreground">{ds.sourceType}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('summary.no_databases_hint')}</p>
              )}
            </div>

            {/* Cohorts */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('summary.cohorts')} ({cohorts.length})
                </span>
                <Link
                  to={`/projects/${uid}/warehouse/cohorts`}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('summary.view_all')}
                  <ArrowRight size={10} />
                </Link>
              </div>
              {cohorts.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {cohorts.map((c) => (
                    <div
                      key={c.id}
                      className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
                    >
                      <span className="truncate text-xs">{c.name}</span>
                      {c.resultCount != null && (
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {c.resultCount.toLocaleString()} {t('summary.results')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('summary.no_cohorts_hint')}</p>
              )}
            </div>
          </div>
        </div>

        {/* Lab */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            <h3 className="text-sm font-semibold">{t('summary.lab_section')}</h3>
          </div>

          <div className="mt-4 space-y-3">
            {/* Datasets */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('summary.datasets')} ({stats.datasetNodes})
                </span>
                <Link
                  to={`/projects/${uid}/lab/datasets`}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('summary.view_all')}
                  <ArrowRight size={10} />
                </Link>
              </div>
              {stats.datasetNodes > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {stats.nodes
                    .filter((n) => n.data.type === 'dataset')
                    .map((n) => (
                      <div
                        key={n.id}
                        className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5"
                      >
                        <PipelineStatusIcon status={n.data.status} />
                        <span className="flex-1 truncate text-xs">
                          {n.data.datasetName || n.data.label}
                        </span>
                        {n.data.rowCount != null && (
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {n.data.rowCount.toLocaleString()} rows
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('summary.no_datasets_hint')}</p>
              )}
            </div>

            {/* Dashboards */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('summary.dashboards')} ({dashTabs.length})
                </span>
                <Link
                  to={`/projects/${uid}/lab/dashboards`}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t('summary.view_all')}
                  <ArrowRight size={10} />
                </Link>
              </div>
              {dashTabs.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {dashTabs.map((tab) => {
                    const wCount = allWidgets.filter((w) => w.tabId === tab.id).length
                    return (
                      <div
                        key={tab.id}
                        className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5"
                      >
                        <span className="truncate text-xs">{tab.name}</span>
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {wCount} {t('summary.widgets')}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('summary.no_dashboards_hint')}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tasks progress */}
      {stats.todos.length > 0 && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t('summary.tasks_progress')}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {stats.todosDone}/{stats.todos.length} {t('summary.completed')}
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{
                width: `${stats.todos.length > 0 ? (stats.todosDone / stats.todos.length) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {Math.round(stats.todos.length > 0 ? (stats.todosDone / stats.todos.length) * 100 : 0)}%
          </p>
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon,
  iconBg,
  value,
  label,
  sub,
}: {
  icon: React.ReactNode
  iconBg: string
  value: number
  label: string
  sub: string
}) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
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
    </div>
  )
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
