import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, Check, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FormField } from '@/components/ui/form-field'
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
import { localized } from '@/lib/localized'
import { useAppStore } from '@/stores/app-store'
import type { Dashboard, DashboardTab, DashboardWidget } from '@/types'
import {
  type ExportFormat,
  type ExportTarget,
  findWidgetNode,
  exportWidget,
  exportWidgetsAsZip,
} from './figure-export'
import { OffscreenWidgetCapture } from './OffscreenWidgetCapture'
import { buildDashboardTree } from './dashboard-tree'

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
  /** When opened from a widget's menu: preselect only this widget. */
  preselectWidgetId?: string | null
}

export function ExportDashboardDialog({ open, onOpenChange, dashboard, tabs, allWidgets, currentTabId, preselectWidgetId }: ExportDashboardDialogProps) {
  const { t } = useTranslation()
  const language = useAppStore((s) => s.language)
  const [format, setFormat] = useState<ExportFormat>('png')
  const [scope, setScope] = useState<Scope>('all')
  const [dpi, setDpi] = useState(384)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  // Set while off-screen widgets render; resolves the promise the export awaits.
  const [capturing, setCapturing] = useState(false)
  const [captureReady, setCaptureReady] = useState(false)

  // Filenames follow the active UI language (matching what the user sees on screen).
  const dashboardName = localized(dashboard.name, language)
  const currentTab = tabs.find(tb => tb.id === currentTabId)
  const currentTabName = currentTab ? localized(currentTab.name, language) : dashboardName

  // Hierarchical rows (tabs → sub-tabs → widgets) for the picker. In "current tab" scope we keep
  // only the active tab's widgets; tab/sub-tab header rows with no widgets in scope are dropped.
  const treeRows = useMemo(() => {
    if (!tabs.length) return []
    const dashboardId = tabs[0].dashboardId
    const full = buildDashboardTree(tabs, allWidgets, dashboardId, language, true)
    if (scope === 'current') {
      return full.filter(r => r.kind === 'widget' && r.tabId === currentTabId)
    }
    // Drop tab headers whose subtree has no widgets, so empty branches don't clutter the list.
    const keep = new Set<string>()
    for (let i = full.length - 1; i >= 0; i--) {
      const r = full[i]
      if (r.kind === 'widget') { keep.add(r.id); for (let j = i - 1; j >= 0; j--) { if (full[j].kind === 'tab' && full[j].depth < r.depth) { keep.add(full[j].id); if (full[j].depth === 0) break } } }
    }
    return full.filter(r => r.kind === 'widget' || keep.has(r.id))
  }, [scope, tabs, currentTabId, allWidgets, language])

  const scopedWidgets = useMemo(
    () => treeRows.filter(r => r.kind === 'widget').map(r => allWidgets.find(w => w.id === r.id)!).filter(Boolean),
    [treeRows, allWidgets],
  )

  // Widgets not in the current tab — these must be rendered off-screen before capture.
  const offscreenWidgets = useMemo(
    () => scopedWidgets.filter(w => w.tabId !== currentTabId && selected.has(w.id)),
    [scopedWidgets, currentTabId, selected],
  )

  // On open: select only the preselected widget (when opened from its menu), else all scoped widgets.
  // On scope change while open: re-select all in the new scope.
  useEffect(() => {
    if (!open) return
    setError('')
    if (preselectWidgetId) {
      setSelected(new Set([preselectWidgetId]))
    } else {
      setSelected(new Set(scopedWidgets.map(w => w.id)))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, preselectWidgetId])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const chosen = useMemo(() => scopedWidgets.filter(w => selected.has(w.id)), [scopedWidgets, selected])

  const collectAndExport = useCallback(async () => {
    try {
      const targets: ExportTarget[] = chosen
        .map(w => ({ id: w.id, name: localized(w.name, language), node: findWidgetNode(w.id) }))
        .filter((x): x is ExportTarget => x.node != null)

      if (targets.length === 0) {
        setError(t('dashboard.export_no_targets', 'No widgets available to export.'))
        return
      }

      if (targets.length === 1) {
        await exportWidget(targets[0].node, targets[0].name, format, dpi)
      } else {
        const zipName = scope === 'all' ? dashboardName : currentTabName
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
  }, [chosen, format, dpi, scope, dashboardName, currentTabName, language, onOpenChange, t])

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
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>{t('dashboard.export_dashboard', 'Export figures')}</DialogTitle>
          <DialogDescription>
            {t('dashboard.export_description_generic', 'Export dashboard widgets as images.')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('dashboard.export_scope', 'Scope')}>
              {() => (
                <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('dashboard.export_scope_all', 'All tabs')}</SelectItem>
                    <SelectItem value="current">{t('dashboard.export_scope_current', 'Current tab')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t('dashboard.export_format', 'Format')}>
              {() => (
                <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG</SelectItem>
                    <SelectItem value="svg">SVG</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>

          {format === 'png' && (
            <FormField label={t('dashboard.export_resolution', 'Resolution')}>
              {() => (
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
              )}
            </FormField>
          )}

          <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>{t('dashboard.export_widgets', 'Widgets')}</Label>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <button type="button" onClick={() => setSelected(new Set(scopedWidgets.map(w => w.id)))} className="hover:text-foreground">
                  {t('common.select_all')}
                </button>
                <span className="text-muted-foreground/40">/</span>
                <button type="button" onClick={() => setSelected(new Set())} className="hover:text-foreground">
                  {t('common.select_none')}
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
              {scopedWidgets.length === 0 && (
                <p className="py-3 text-center text-[11px] text-muted-foreground">
                  {t('dashboard.export_no_widgets', 'No widgets in this scope.')}
                </p>
              )}
              {treeRows.map(row => {
                const indent = { paddingLeft: 10 + row.depth * 14 }
                if (row.kind === 'tab') {
                  return (
                    <div
                      key={row.id}
                      style={indent}
                      className="flex items-center gap-1.5 bg-muted/40 py-1 pr-2.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      {row.isContainer ? <Layers size={11} className="shrink-0" /> : null}
                      <span className="truncate">{row.name}</span>
                    </div>
                  )
                }
                const isSel = selected.has(row.id)
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => toggle(row.id)}
                    style={indent}
                    className={cn(
                      'flex w-full items-center gap-2 border-t py-1.5 pr-2.5 text-xs transition-colors first:border-t-0',
                      isSel ? 'bg-accent/50' : 'hover:bg-accent/30',
                    )}
                  >
                    <div className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                      isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30',
                    )}>
                      {isSel && <Check size={10} />}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-left">{row.name}</span>
                  </button>
                )
              })}
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
