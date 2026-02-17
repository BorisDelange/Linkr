import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { DashboardWidget } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { WidgetCard } from './WidgetCard'
import { PluginWidgetRenderer } from './widget-renderers/PluginWidgetRenderer'
import { InlineCodeWidgetRenderer } from './widget-renderers/InlineCodeWidgetRenderer'
import { WidgetEditorDialog } from './WidgetEditorDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface WidgetGridProps {
  widgets: DashboardWidget[]
  editMode: boolean
  hideTitleBars?: boolean
}

function renderWidgetContent(widget: DashboardWidget) {
  switch (widget.source.type) {
    case 'plugin':
      return <PluginWidgetRenderer widget={widget} />
    case 'inline':
      return <InlineCodeWidgetRenderer widget={widget} />
    default:
      return <div className="text-xs text-muted-foreground">Unknown widget type</div>
  }
}

export function WidgetGrid({ widgets, editMode, hideTitleBars }: WidgetGridProps) {
  const { t } = useTranslation()
  const { updateWidgetLayout, removeWidget } = useDashboardStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null)
  const [confirmDeleteWidgetId, setConfirmDeleteWidgetId] = useState<string | null>(null)
  const confirmDeleteWidget = confirmDeleteWidgetId ? widgets.find(w => w.id === confirmDeleteWidgetId) ?? null : null

  const editingWidget = editingWidgetId ? widgets.find(w => w.id === editingWidgetId) ?? null : null

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(containerRef.current)
    setContainerWidth(containerRef.current.clientWidth)
    return () => observer.disconnect()
  }, [])

  const layout: LayoutItem[] = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.id,
        x: w.layout.x,
        y: w.layout.y,
        w: w.layout.w,
        h: w.layout.h,
        minW: 2,
        minH: 2,
      })),
    [widgets]
  )

  const handleLayoutChange = useCallback(
    (newLayout: readonly LayoutItem[]) => {
      for (const item of newLayout) {
        const widget = widgets.find((w) => w.id === item.i)
        if (
          widget &&
          (widget.layout.x !== item.x ||
            widget.layout.y !== item.y ||
            widget.layout.w !== item.w ||
            widget.layout.h !== item.h)
        ) {
          updateWidgetLayout(item.i, {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          })
        }
      }
    },
    [widgets, updateWidgetLayout]
  )

  return (
    <div ref={containerRef} className="w-full">
      <GridLayout
        layout={layout}
        width={containerWidth}
        gridConfig={{
          cols: 24,
          rowHeight: 40,
          margin: [12, 12] as [number, number],
          containerPadding: [16, 16] as [number, number],
        }}
        dragConfig={{
          enabled: editMode,
        }}
        resizeConfig={{
          enabled: editMode,
        }}
        onLayoutChange={handleLayoutChange}
        autoSize
      >
        {widgets.map((widget) => (
          <div key={widget.id}>
            <WidgetCard
              title={widget.name}
              onRemove={() => setConfirmDeleteWidgetId(widget.id)}
              onEdit={() => setEditingWidgetId(widget.id)}
              editMode={editMode}
              hideTitleBar={hideTitleBars}
            >
              {renderWidgetContent(widget)}
            </WidgetCard>
          </div>
        ))}
      </GridLayout>

      <WidgetEditorDialog
        widget={editingWidget}
        open={editingWidgetId !== null}
        onOpenChange={(open) => { if (!open) setEditingWidgetId(null) }}
      />

      <AlertDialog open={confirmDeleteWidgetId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteWidgetId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dashboard.delete_widget_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('dashboard.delete_widget_description', { name: confirmDeleteWidget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirmDeleteWidgetId) removeWidget(confirmDeleteWidgetId)
                setConfirmDeleteWidgetId(null)
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
