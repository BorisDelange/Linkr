import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router'
import { resolveByIdPrefix } from '@/lib/short-id'
import type { UiContext } from '@/lib/api/notifications'
import { useAppStore } from '@/stores/app-store'
import { useCohortStore } from '@/stores/cohort-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { useNotificationStore } from '@/stores/notification-store'

const PROJECT_ROUTE = /^\/workspaces\/[^/]+\/projects\/([^/]+)(?:\/(.*))?$/

/**
 * Publish where the user is — project, page, open cohort / dashboard (and its
 * active tab) / dataset — so an agent over MCP can resolve "this cohort" or
 * "here". Re-sent when the window regains focus: with several tabs open, the one
 * the user last looked at is the one that counts.
 */
export function useUiContextPublisher(enabled: boolean) {
  const { pathname } = useLocation()
  const projects = useAppStore((s) => s.projects)
  const cohorts = useCohortStore((s) => s.cohorts)
  const dashboards = useDashboardStore((s) => s.dashboards)
  const activeTabIds = useDashboardStore((s) => s.activeTabId)
  const datasetFiles = useDatasetStore((s) => s.files)
  const selectedFileId = useDatasetStore((s) => s.selectedFileId)
  const publish = useNotificationStore((s) => s.publishContext)

  const context = useMemo<UiContext>(() => {
    const match = PROJECT_ROUTE.exec(pathname)
    if (!match) return { path: pathname, projectUid: null, page: null }
    const projectUid = resolveByIdPrefix(projects, match[1], (p) => p.uid)?.uid ?? null
    const rest = (match[2] ?? '').split('/').filter(Boolean)
    const ctx: UiContext = { path: pathname, projectUid, page: rest.slice(0, 2).join('/') || 'summary' }
    if (rest[0] === 'warehouse' && rest[1] === 'cohorts' && rest[2]) {
      ctx.cohortId = resolveByIdPrefix(cohorts, rest[2], (c) => c.id)?.id
    }
    if (rest[0] === 'lab' && rest[1] === 'dashboards' && rest[2]) {
      const dashboardId = resolveByIdPrefix(dashboards, rest[2], (d) => d.id)?.id
      ctx.dashboardId = dashboardId
      if (dashboardId) ctx.dashboardTabId = activeTabIds[dashboardId]
    }
    if (rest[0] === 'lab' && rest[1] === 'datasets' && selectedFileId) {
      ctx.datasetPath = datasetFiles.find((f) => f.id === selectedFileId)?.path
    }
    return ctx
  }, [pathname, projects, cohorts, dashboards, activeTabIds, datasetFiles, selectedFileId])

  useEffect(() => {
    if (!enabled) return
    publish(context)
    const onFocus = () => publish(context)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, context, publish])
}
