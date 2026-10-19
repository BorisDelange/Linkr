import { useMemo, useState, type ReactNode } from 'react'
import type { PatientDashboard, PatientDashboardTab, PatientDashboardWidget } from '@/types'
import { PatientChartGrid } from './PatientChartGrid'
import { TabVisibilityContext } from './TabVisibilityContext'

interface BoardTabGridsProps {
  board: PatientDashboard
  /** The board's tabs, in display order. */
  tabs: PatientDashboardTab[]
  /** Every widget of the store; each tab takes its own. */
  widgets: PatientDashboardWidget[]
  currentTabId: string | undefined
  editMode: boolean
  /** Shown in place of the grid when the current tab has no widget. */
  empty: ReactNode
}

/**
 * A patient board's tab grids. Once shown, a tab stays mounted, hidden with CSS
 * while another is on screen, so returning to it neither redraws its charts nor
 * reloads its rows. Unvisited tabs are never mounted. "Reload widgets on tab
 * switch" turns this off: only the current tab is mounted, so leaving it frees
 * it and returning reloads it.
 */
export function BoardTabGrids({ board, tabs, widgets, currentTabId, editMode, empty }: BoardTabGridsProps) {
  const keepAlive = board.reloadWidgetsOnTabSwitch !== true

  // Each tab's slice keeps a stable reference across tab switches, so a kept-alive grid whose
  // props are otherwise unchanged doesn't re-reconcile its charts on every board render.
  const widgetsByTab = useMemo(() => {
    const m = new Map<string, PatientDashboardWidget[]>()
    for (const w of widgets) {
      const list = m.get(w.tabId)
      if (list) list.push(w)
      else m.set(w.tabId, [w])
    }
    return m
  }, [widgets])
  const emptyWidgets = useMemo<PatientDashboardWidget[]>(() => [], [])

  const isMountableTab = !!currentTabId && (widgetsByTab.get(currentTabId)?.length ?? 0) > 0
  const [visited, setVisited] = useState<{ boardId: string; tabIds: Set<string> }>({ boardId: board.id, tabIds: new Set() })
  // Another board's tab ids no longer apply.
  const visitedTabIds = visited.boardId === board.id ? visited.tabIds : null
  // Recorded while rendering, as React has state derived from props adjusted.
  if (keepAlive && isMountableTab && currentTabId && !visitedTabIds?.has(currentTabId)) {
    setVisited({ boardId: board.id, tabIds: new Set(visitedTabIds ?? []).add(currentTabId) })
  }

  if (!isMountableTab) return <>{empty}</>

  // With keep-alive: every visited tab, the current one included. Without: only the
  // current tab, so switching away unmounts it.
  const mountedTabs = tabs.filter((tab) =>
    tab.id === currentTabId || (keepAlive && !!visitedTabIds?.has(tab.id)),
  )

  return (
    <>
      {mountedTabs.map((tab) => (
        <div
          key={tab.id}
          // `hidden`, not `invisible`: visibility is inherited but a
          // descendant can override it, and a Dygraph does — its legend
          // and range selector are positioned absolutely with a z-index,
          // so a timeline on a hidden tab stayed painted over the visible
          // one. display:none cannot be overridden from inside.
          className={tab.id === currentTabId ? 'contents' : 'hidden absolute top-0 left-0 w-full'}
          aria-hidden={tab.id !== currentTabId}
        >
          {/* Kept-alive tabs stay mounted, and a patient widget refetches
              on every patient/visit change — so without this a hidden tab
              would query the warehouse alongside the visible one. */}
          <TabVisibilityContext.Provider value={tab.id === currentTabId}>
            <PatientChartGrid
              widgets={widgetsByTab.get(tab.id) ?? emptyWidgets}
              tabs={tabs}
              editMode={editMode}
              hideTitleBars={(board.showWidgetTitles ?? true) === false}
              widgetSpacing={board.widgetSpacing}
              fitToHeight={board.fitToHeight ?? true}
            />
          </TabVisibilityContext.Provider>
        </div>
      ))}
    </>
  )
}
