import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { Plus, LayoutGrid, Pencil, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDashboardStore } from '@/stores/dashboard-store'
import { DashboardTabBar } from './dashboard/DashboardTabBar'
import { WidgetGrid } from './dashboard/WidgetGrid'
import { AddWidgetDialog } from './dashboard/AddWidgetDialog'

export function DashboardPage() {
  const { t } = useTranslation()
  const { uid } = useParams()
  const projectUid = uid ?? ''
  const [addWidgetOpen, setAddWidgetOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const { tabs, widgets, activeTabId } = useDashboardStore()

  const projectTabs = tabs
    .filter((tab) => tab.projectUid === projectUid)
    .sort((a, b) => a.displayOrder - b.displayOrder)
  const currentTabId = activeTabId[projectUid] ?? projectTabs[0]?.id
  const tabWidgets = widgets.filter((w) => w.tabId === currentTabId)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Tab bar + actions */}
      <div className="flex items-center border-b px-3 shrink-0">
        <DashboardTabBar projectUid={projectUid} />

        <div className="ml-auto flex items-center gap-1 py-1">
          {editMode && (
            <Button
              size="xs"
              className="gap-1"
              onClick={() => setAddWidgetOpen(true)}
            >
              <Plus size={12} />
              {t('dashboard.add_widget')}
            </Button>
          )}
          <Button
            variant={editMode ? 'default' : 'ghost'}
            size="xs"
            className="gap-1"
            onClick={() => setEditMode(!editMode)}
          >
            {editMode ? (
              <>
                <Lock size={12} />
                {t('dashboard.lock_layout')}
              </>
            ) : (
              <>
                <Pencil size={12} />
                {t('dashboard.edit_layout')}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Main content area */}
      <ScrollArea className="flex-1 min-h-0">
        {tabWidgets.length > 0 ? (
          <WidgetGrid widgets={tabWidgets} editMode={editMode} />
        ) : (
          <div className="flex h-full min-h-[400px] items-center justify-center p-8">
            <div className="flex w-full max-w-md flex-col items-center rounded-xl border-2 border-dashed border-muted-foreground/25 py-16">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                <LayoutGrid size={24} className="text-muted-foreground" />
              </div>
              <h3 className="mt-4 text-sm font-medium text-foreground">
                {t('dashboard.empty_title')}
              </h3>
              <p className="mt-1.5 max-w-xs text-center text-xs text-muted-foreground">
                {t('dashboard.empty_description')}
              </p>
              <Button
                size="sm"
                className="mt-4 gap-1.5"
                onClick={() => {
                  setEditMode(true)
                  setAddWidgetOpen(true)
                }}
              >
                <Plus size={14} />
                {t('dashboard.add_widget')}
              </Button>
            </div>
          </div>
        )}
      </ScrollArea>

      <AddWidgetDialog
        open={addWidgetOpen}
        onOpenChange={setAddWidgetOpen}
        tabId={currentTabId ?? ''}
      />
    </div>
  )
}
