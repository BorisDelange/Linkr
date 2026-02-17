import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { DashboardWidget } from '@/types'
import { useDashboardStore } from '@/stores/dashboard-store'
import { WidgetCard } from './WidgetCard'
import { BuiltinWidgetRenderer } from './widget-renderers/BuiltinWidgetRenderer'
import { PluginWidgetRenderer } from './widget-renderers/PluginWidgetRenderer'
import { InlineCodeWidgetRenderer } from './widget-renderers/InlineCodeWidgetRenderer'

interface WidgetGridProps {
  widgets: DashboardWidget[]
  editMode: boolean
}

function renderWidgetContent(widget: DashboardWidget) {
  switch (widget.source.type) {
    case 'builtin':
      return <BuiltinWidgetRenderer widget={widget} />
    case 'plugin':
      return <PluginWidgetRenderer widget={widget} />
    case 'inline':
      return <InlineCodeWidgetRenderer widget={widget} />
    default:
      return <div className="text-xs text-muted-foreground">Unknown widget type</div>
  }
}

export function WidgetGrid({ widgets, editMode }: WidgetGridProps) {
  const { updateWidgetLayout, removeWidget } = useDashboardStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)

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
              onRemove={() => removeWidget(widget.id)}
              editMode={editMode}
            >
              {renderWidgetContent(widget)}
            </WidgetCard>
          </div>
        ))}
      </GridLayout>
    </div>
  )
}
