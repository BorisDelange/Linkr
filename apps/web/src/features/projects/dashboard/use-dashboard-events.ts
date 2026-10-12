import { useMemo } from 'react'
import { useDashboardStore } from '@/stores/dashboard-store'
import type { DashboardEvent } from '@/types'
import { readDashboardEvents } from '@/lib/dashboard-events'

/** The events of the dashboard owning `tabId` — what a widget of that tab can mark. */
export function useTabDashboardEvents(tabId: string | undefined): DashboardEvent[] {
  const raw = useDashboardStore((s) => {
    const dashboardId = s.tabs.find((t) => t.id === tabId)?.dashboardId
    return s.dashboards.find((d) => d.id === dashboardId)?.events
  })
  return useMemo(() => readDashboardEvents(raw), [raw])
}
