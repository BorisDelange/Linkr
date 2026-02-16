import { useMemo, useCallback, useRef, useEffect, useState } from 'react'
import { GridLayout, type LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { useDashboardStore, type DashboardWidget } from '@/stores/dashboard-store'
import { WidgetCard } from './WidgetCard'
import { AdmissionCountWidget } from './widgets/AdmissionCountWidget'
import { PatientCountWidget } from './widgets/PatientCountWidget'
import { AdmissionTimelineWidget } from './widgets/AdmissionTimelineWidget'
import { HeartRateWidget } from './widgets/HeartRateWidget'
import { VitalsTableWidget } from './widgets/VitalsTableWidget'

interface WidgetGridProps {
  widgets: DashboardWidget[]
  editMode: boolean
}

function renderWidgetContent(type: string) {
  switch (type) {
    case 'admission_count':
      return <AdmissionCountWidget />
    case 'patient_count':
      return <PatientCountWidget />
    case 'admission_timeline':
      return <AdmissionTimelineWidget />
    case 'heart_rate':
      return <HeartRateWidget />
    case 'vitals_table':
      return <VitalsTableWidget />
    default:
      return <div className="text-xs text-muted-foreground">Unknown widget</div>
  }
}

export function WidgetGrid({ widgets, editMode }: WidgetGridProps) {
  const { updateWidgetLayout, removeWidget } = useDashboardStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(1200)

  // Measure container width and react to resizes
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
              {renderWidgetContent(widget.type)}
            </WidgetCard>
          </div>
        ))}
      </GridLayout>
    </div>
  )
}
