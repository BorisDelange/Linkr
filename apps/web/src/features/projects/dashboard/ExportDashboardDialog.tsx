import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Dashboard, DashboardTab, DashboardWidget } from '@/types'
import {
  type ExportFormat,
  type ExportTarget,
  findWidgetNode,
  exportWidget,
  exportWidgetsAsZip,
} from './figure-export'
import { OffscreenWidgetCapture } from './OffscreenWidgetCapture'

type Scope = 'current' | 'all'

interface ExportDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dashboard: Dashboard
  /** All tabs of this dashboard, in display order. */
  tabs: DashboardTab[]
  /** All widgets across all tabs of this dashboard. */
  allWidgets: DashboardWidget[]
  /** The currently-displayed tab (its widgets are already mounted in the DOM). */
  currentTabId: string | undefined
}

export function ExportDashboardDialog({ open, onOpenChange, dashboard, tabs, allWidgets, currentTabId }: ExportDashboardDialogProps) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ExportFormat>('png')
  const [scope, setScope] = useState<Scope>('all')
  const [dpi, setDpi] = useState(192)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  // Set while off-screen widgets render; resolves the promise the export awaits.
  const [capturing, setCapturing] = useState(false)
  const [captureReady, setCaptureReady] = useState(false)

  const currentTabName = tabs.find(tb => tb.id === currentTabId)?.name ?? dashboard.name

  // Widgets in scope, grouped by tab for display.
  const scopedTabs = useMemo(() => {
    const tabsInScope = scope === 'current' ? tabs.filter(tb => tb.id === currentTabId) : tabs
    return tabsInScope
      .map(tb => ({ tab: tb, widgets: allWidgets.filter(w => w.tabId === tb.id) }))
      .filter(g => g.widgets.length > 0)
  }, [scope, tabs, currentTabId, allWidgets])

  const scopedWidgets = useMemo(() => scopedTabs.flatMap(g => g.widgets), [scopedTabs])

  // Widgets not in the current tab — these must be rendered off-screen before capture.
  const offscreenWidgets = useMemo(
    () => scopedWidgets.filter(w => w.tabId !== currentTabId && selected.has(w.id)),
    [scopedWidgets, currentTabId, selected],
  )

  // Re-select everything whenever scope changes or the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set(scopedWidgets.map(w => w.id)))
      setError('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope])

  const allSelected = scopedWidgets.length > 0 && scopedWidgets.every(w => selected.has(w.id))
  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(scopedWidgets.map(w => w.id)))
  }

  const chosen = useMemo(() => scopedWidgets.filter(w => selected.has(w.id)), [scopedWidgets, selected])

  const collectAndExport = useCallback(async () => {
    try {
      const targets: ExportTarget[] = chosen
        .map(w => ({ id: w.id, name: w.name, node: findWidgetNode(w.id) }))
        .filter((x): x is ExportTarget => x.node != null)

      if (targets.length === 0) {
        setError(t('dashboard.export_no_targets', 'No widgets available to export.'))
        return
      }

      if (targets.length === 1) {
        await exportWidget(targets[0].node, targets[0].name, format, dpi)
      } else {
        const zipName = scope === 'all' ? dashboard.name : currentTabName
        const { exported, failed } = await exportWidgetsAsZip(targets, format, zipName || 'dashboard', dpi)
        if (exported === 0) {
          setError(t('dashboard.export_failed', 'Export failed.'))
          return
        }
        if (failed.length > 0) {
          setError(t('dashboard.export_partial', { count: failed.length, defaultValue: '{{count}} widget(s) could not be exported.' }))
          return
        }
      }
      onOpenChange(false)
    } catch {
      setError(t('dashboard.export_failed', 'Export failed.'))
    } finally {
      setExporting(false)
      setCapturing(false)
      setCaptureReady(false)
    }
  }, [chosen, format, dpi, scope, dashboard.name, currentTabName, onOpenChange, t])

  // Once off-screen widgets report ready, run the actual capture.
  useEffect(() => {
    if (capturing && captureReady) {
      collectAndExport()
    }
  }, [capturing, captureReady, collectAndExport])

  const handleExport = async () => {
    setError('')
    setExporting(true)
    if (offscreenWidgets.length > 0) {
      // Mount OffscreenWidgetCapture; its onReady triggers collectAndExport via the effect above.
      setCaptureReady(false)
      setCapturing(true)
    } else {
      await collectAndExport()
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!exporting) onOpenChange(o) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dashboard.export_dashboard', 'Export figures')}</DialogTitle>
          <DialogDescription>
            {t('dashboard.export_description_generic', 'Export dashboard widgets as images.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('dashboard.export_scope', 'Scope')}</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('dashboard.export_scope_all', 'All tabs')}</SelectItem>
                  <SelectItem value="current">{t('dashboard.export_scope_current', 'Current tab')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('dashboard.export_format', 'Format')}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">PNG</SelectItem>
                  <SelectItem value="svg">SVG</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {format === 'png' && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('dashboard.export_resolution', 'Resolution')}</Label>
              <Select value={String(dpi)} onValueChange={(v) => setDpi(Number(v))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="96">96 DPI · {t('dashboard.export_dpi_screen', 'Screen')}</SelectItem>
                  <SelectItem value="192">192 DPI · {t('dashboard.export_dpi_high', 'High (2×)')}</SelectItem>
                  <SelectItem value="288">288 DPI · {t('dashboard.export_dpi_print', 'Print (3×)')}</SelectItem>
                  <SelectItem value="384">384 DPI · {t('dashboard.export_dpi_max', 'Max (4×)')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('dashboard.export_widgets', 'Widgets')}</Label>
              <button type="button" onClick={toggleAll} className="text-[10px] text-muted-foreground hover:text-foreground">
                {allSelected ? t('common.select_none') : t('common.select_all')}
              </button>
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border">
              {scopedWidgets.length === 0 && (
                <p className="py-3 text-center text-[11px] text-muted-foreground">
                  {t('dashboard.export_no_widgets', 'No widgets in this scope.')}
                </p>
              )}
              {scopedTabs.map(group => (
                <div key={group.tab.id}>
                  {scope === 'all' && (
                    <div className="bg-muted/50 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.tab.name}
                    </div>
                  )}
                  {group.widgets.map(w => {
                    const isSel = selected.has(w.id)
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => toggle(w.id)}
                        className={cn(
                          'flex w-full items-center gap-2 border-t px-2.5 py-1.5 text-xs transition-colors first:border-t-0',
                          isSel ? 'bg-accent/50' : 'hover:bg-accent/30',
                        )}
                      >
                        <div className={cn(
                          'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                          isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
                        )}>
                          {isSel && <Check size={10} />}
                        </div>
                        <span className="truncate">{w.name}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={exporting}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={handleExport} disabled={exporting || chosen.length === 0}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {t('dashboard.export_count', { count: chosen.length, defaultValue: 'Export ({{count}})' })}
          </Button>
        </DialogFooter>
      </DialogContent>

      {capturing && (
        <OffscreenWidgetCapture
          widgets={offscreenWidgets}
          dashboard={dashboard}
          onReady={() => setCaptureReady(true)}
        />
      )}
    </Dialog>
  )
}
