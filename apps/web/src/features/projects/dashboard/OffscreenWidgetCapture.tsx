import { useEffect, useRef, useState } from 'react'
import type { Dashboard, DashboardWidget } from '@/types'
import { localized } from '@/lib/localized'
import { DashboardDataProvider } from './DashboardDataProvider'
import { PluginWidgetRenderer } from './widget-renderers/PluginWidgetRenderer'
import { InlineCodeWidgetRenderer } from './widget-renderers/InlineCodeWidgetRenderer'

interface OffscreenWidgetCaptureProps {
  widgets: DashboardWidget[]
  dashboard: Dashboard
  /** Pixel size each off-screen widget is rendered at before capture. */
  cellWidth?: number
  cellHeight?: number
  /** Called once the widgets have had time to render their charts. */
  onReady: () => void
  /** Settle delay (ms) before signalling readiness — charts/maps need a tick to paint. */
  settleMs?: number
}

/**
 * Mounts widgets in a fixed-size, visually-hidden container so their DOM (recharts SVG,
 * Leaflet canvas, tables) exists and can be snapshotted by figure-export's findWidgetNode.
 * Used to export widgets from tabs that aren't currently displayed.
 *
 * Kept on-screen but off-viewport (not display:none) so layout/measurement still runs —
 * html-to-image and recharts need real box dimensions.
 */
export function OffscreenWidgetCapture({
  widgets,
  dashboard: _dashboard,
  cellWidth = 640,
  cellHeight = 420,
  onReady,
  settleMs = 600,
}: OffscreenWidgetCaptureProps) {
  const [mounted, setMounted] = useState(false)
  const calledRef = useRef(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted || calledRef.current) return
    const id = setTimeout(() => {
      calledRef.current = true
      onReady()
    }, settleMs)
    return () => clearTimeout(id)
  }, [mounted, settleMs, onReady])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        opacity: 0,
        pointerEvents: 'none',
        zIndex: -1,
        overflow: 'hidden',
        width: cellWidth,
      }}
    >
      {widgets.map((widget) => (
        <div
          key={widget.id}
          data-widget-id={widget.id}
          data-widget-name={localized(widget.name, 'en')}
          style={{ width: cellWidth, height: cellHeight }}
        >
          {/* Mirrors WidgetCard's content wrapper so findWidgetNode resolves the same node. */}
          <div className="flex h-full flex-col rounded-lg border bg-card" data-widget-content>
            <DashboardDataProvider datasetFileId={widget.datasetFileId ?? null}>
              <div className="h-full">
                {widget.source.type === 'plugin' ? (
                  <PluginWidgetRenderer widget={widget} />
                ) : widget.source.type === 'inline' ? (
                  <InlineCodeWidgetRenderer widget={widget} />
                ) : null}
              </div>
            </DashboardDataProvider>
          </div>
        </div>
      ))}
    </div>
  )
}
