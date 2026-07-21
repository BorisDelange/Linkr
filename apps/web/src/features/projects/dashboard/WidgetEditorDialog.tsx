import { useState, useCallback, useRef, useEffect, useMemo, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Play, RotateCcw, Settings, Code2, X, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { localized } from '@/lib/localized'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import { getComponent, componentSupportsServer } from '@/lib/plugins/component-registry'
import { getLucideIcon } from '@/lib/plugins/shared-styles'
import { getBadgeClasses, getBadgeStyle } from '@/features/projects/ProjectSettingsPage'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDatasetStore } from '@/stores/dataset-store'
import { DashboardDataProvider, useDashboardData } from './DashboardDataProvider'
import { resolveServerFilters } from './resolve-server-filters'
import { isServerMode } from '@/lib/api-client'
import { executeOnServer } from '@/lib/api/execution'
import { widgetPixelSize, DASHBOARD_GRID, colWidthFor } from './dashboard-grid'
import type { DashboardWidget, DashboardWidgetSource, DatasetColumn } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { PluginConfigField } from '@/types/plugin'
import type * as Monaco from 'monaco-editor'

interface WidgetEditorDialogProps {
  widget: DashboardWidget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  projectUid: string
  /** Measured pixel width of the dashboard grid — used to size the preview like the real widget. */
  gridWidth?: number
  /** Per-dashboard widget spacing (px) so the preview size matches the live grid. */
  widgetSpacing?: number
}

export function WidgetEditorDialog({ widget, open, onOpenChange, projectUid, gridWidth, widgetSpacing }: WidgetEditorDialogProps) {
  // Read the live widget from the store so dataset/config edits made in the editor
  // (e.g. picking a dataset) immediately reach the preview — the `widget` prop is a
  // snapshot and would otherwise leave the preview provider with a stale datasetFileId.
  const liveWidget = useDashboardStore((s) => s.widgets.find((w) => w.id === widget?.id))
  const current = liveWidget ?? widget
  if (!current) return null
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[calc(100vw-16rem)] max-w-none sm:max-w-none p-0 gap-0"
      >
        <DashboardDataProvider datasetFileId={current.datasetFileId ?? null}>
          <WidgetEditorContent widget={current} onClose={() => onOpenChange(false)} projectUid={projectUid} gridWidth={gridWidth} widgetSpacing={widgetSpacing} />
        </DashboardDataProvider>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Editor content
// ---------------------------------------------------------------------------

function WidgetEditorContent({ widget, onClose, projectUid, gridWidth, widgetSpacing }: { widget: DashboardWidget; onClose: () => void; projectUid: string; gridWidth?: number; widgetSpacing?: number }) {
  const { t, i18n } = useTranslation()
  const { updateWidgetSource, updateWidgetDataset } = useDashboardStore()
  const { filteredRows, columns, datasetFileId, filters } = useDashboardData()
  const { files: datasetFiles } = useDatasetStore()

  const projectDatasetFiles = datasetFiles.filter(
    (f) => f.projectUid === projectUid && f.type === 'file' && f.columns && f.columns.length > 0
  )

  const source = widget.source
  const isPlugin = source.type === 'plugin'
  const isInline = source.type === 'inline'

  // Resolve plugin info
  const plugin = isPlugin ? getPlugin(source.pluginId) : null
  const hasConfigSchema = plugin?.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0
  const isComponentPlugin = !!(plugin?.componentId && plugin.manifest.runtime.includes('component'))

  // Detect language — use persisted value if available, otherwise default
  const hasBothLanguages = isPlugin && !isComponentPlugin && plugin?.templates?.python && plugin?.templates?.r
  const language: 'python' | 'r' = isInline
    ? ((source.language === 'r' ? 'r' : 'python') as 'python' | 'r')
    : (isPlugin && source.language) ? source.language
    : plugin?.templates?.python
      ? 'python'
      : 'r'

  // Local config state
  const [config, setConfig] = useState<Record<string, unknown>>(source.config ?? {})
  const [activeTab, setActiveTab] = useState<'config' | 'code' | null>(hasConfigSchema ? 'config' : 'code')

  // Code state
  const [isCodeCustomized, setIsCodeCustomized] = useState(
    (source.config?.isCodeCustomized as boolean) ?? false,
  )
  const [userCode, setUserCode] = useState(
    (source.config?.userCode as string) ?? '',
  )

  // Execution state
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [installedDeps, setInstalledDeps] = useState<string[]>([])
  const isExecutingRef = useRef(false)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  // Debounced config for live preview — avoids re-rendering on every keystroke
  const [debouncedConfig, setDebouncedConfig] = useState(config)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedConfig(config), 300)
    return () => clearTimeout(debounceRef.current)
  }, [config])

  // Reset state when the target widget changes, or when its dataset is swapped — the
  // latter remaps column references in the store, so the local config must re-sync.
  useEffect(() => {
    setConfig(widget.source.config ?? {})
    setDebouncedConfig(widget.source.config ?? {})
    setIsCodeCustomized((widget.source.config?.isCodeCustomized as boolean) ?? false)
    setUserCode((widget.source.config?.userCode as string) ?? '')
    setResult(null)
  }, [widget.id, widget.datasetFileId])

  // Generate code from template
  const generatedCode = useGeneratedCode(plugin ?? undefined, config, columns, language)
  const currentCode = isInline
    ? ((source as { code: string }).code ?? '')
    : (isCodeCustomized && userCode ? userCode : generatedCode)

  // Persist changes to store
  const persistSource = useCallback((updates: Partial<DashboardWidgetSource>) => {
    const newSource = { ...widget.source, ...updates } as DashboardWidgetSource
    updateWidgetSource(widget.id, newSource)
  }, [widget.id, widget.source, updateWidgetSource])

  // Config changes
  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    const newConfig = { ...config, ...changes }
    setConfig(newConfig)
    if (isCodeCustomized) {
      // Reset code customization when config changes
      setIsCodeCustomized(false)
      setUserCode('')
      persistSource({ config: { ...newConfig, isCodeCustomized: false, userCode: undefined } })
    } else {
      persistSource({ config: newConfig })
    }
  }, [config, isCodeCustomized, persistSource])

  // Code editing
  const handleCodeChange = useCallback((value: string | undefined) => {
    if (value === undefined) return
    if (isInline) {
      persistSource({ code: value } as Partial<DashboardWidgetSource>)
    } else {
      if (value === generatedCode) {
        setIsCodeCustomized(false)
        setUserCode('')
        persistSource({ config: { ...config, isCodeCustomized: false, userCode: undefined } })
      } else {
        setIsCodeCustomized(true)
        setUserCode(value)
        persistSource({ config: { ...config, isCodeCustomized: true, userCode: value } })
      }
    }
  }, [isInline, generatedCode, config, persistSource])

  const handleResetCode = useCallback(() => {
    setIsCodeCustomized(false)
    setUserCode('')
    persistSource({ config: { ...config, isCodeCustomized: false, userCode: undefined } })
  }, [config, persistSource])

  // Language change (for plugin widgets)
  const handleLanguageChange = useCallback((newLang: 'python' | 'r') => {
    persistSource({ language: newLang } as Partial<DashboardWidgetSource>)
    setIsCodeCustomized(false)
    setUserCode('')
  }, [persistSource])

  // Run execution. `code` defaults to the full editor content; the keyboard shortcuts
  // pass a selection or single line to run a subset.
  const handleRun = useCallback(async (code?: string) => {
    if (isExecutingRef.current) return
    isExecutingRef.current = true
    setIsExecuting(true)
    setResult(null)
    setStatusMessage(null)

    try {
      let output
      if (isServerMode()) {
        // Server mode: backend injects the dataset Parquet as `dataset` (with the
        // dashboard filters), so the preview runs on real data — not filteredRows,
        // which is empty server-side.
        output = await executeOnServer(language, code ?? currentCode, {
          projectUid,
          datasetFileId: datasetFileId ?? undefined,
          datasetFilters: datasetFileId ? resolveServerFilters(filters, columns) : undefined,
        })
      } else {
        if (isPlugin && plugin) {
          const newlyInstalled = await ensurePluginDependencies(plugin.manifest.id, language, (msg) => setStatusMessage(msg))
          setInstalledDeps(newlyInstalled)
          setStatusMessage(null)
        }
        const executor = await import('@/features/projects/lab/datasets/analysis-executor')
        const exec = language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
        output = await exec(code ?? currentCode, filteredRows, columns)
      }
      setResult(output)
    } catch (err) {
      setResult({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        figures: [],
        table: null,
        html: null,
      })
    } finally {
      isExecutingRef.current = false
      setIsExecuting(false)
      setStatusMessage(null)
    }
  }, [currentCode, filteredRows, columns, language, isPlugin, plugin, datasetFileId, filters, projectUid])

  // Cmd/Ctrl+Shift+Enter: run the whole file.
  const handleRunFile = useCallback(() => { void handleRun() }, [handleRun])

  // Cmd/Ctrl+Enter: run the selection if any, otherwise the current line (RStudio convention).
  const handleRunSelectionOrLine = useCallback(() => {
    const editor = editorRef.current
    if (!editor) { void handleRun(); return }
    const model = editor.getModel()
    const selection = editor.getSelection()
    if (model && selection && !selection.isEmpty()) {
      const text = model.getValueInRange(selection)
      if (text.trim()) { void handleRun(text); return }
    }
    const position = editor.getPosition()
    if (model && position) {
      const line = model.getLineContent(position.lineNumber)
      if (line.trim()) { void handleRun(line); return }
    }
    void handleRun()
  }, [handleRun])

  const leftVisible = activeTab !== null
  const configSchema = plugin?.manifest.configSchema ?? {}

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SheetHeader className="flex-row items-center gap-2 border-b px-3 py-2 space-y-0">
        <SheetTitle className="text-sm truncate">{localized(widget.name, i18n.language)}</SheetTitle>
        <div className="flex-1" />
        {plugin && <PluginBadge plugin={plugin} lang={i18n.language as 'en' | 'fr'} />}
        <Select
          value={widget.datasetFileId ?? '__none__'}
          onValueChange={(v) => updateWidgetDataset(widget.id, v === '__none__' ? null : v)}
        >
          <SelectTrigger className="h-6 w-auto max-w-48 gap-1 text-xs border-dashed">
            <Database size={11} className="text-muted-foreground shrink-0" />
            <SelectValue placeholder={t('dashboard.widget_dataset_placeholder')} />
          </SelectTrigger>
          <SelectContent position="popper" sideOffset={4}>
            <SelectItem value="__none__">{t('dashboard.widget_dataset_none')}</SelectItem>
            {projectDatasetFiles.map((f) => (
              <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasBothLanguages && (
          <Select value={language} onValueChange={(v) => handleLanguageChange(v as 'python' | 'r')}>
            <SelectTrigger className="h-6 w-auto gap-1 text-xs border-dashed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={4}>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="r">R</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={14} />
        </Button>
      </SheetHeader>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {hasConfigSchema && (
          <button
            onClick={() => setActiveTab(activeTab === 'config' ? null : 'config')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              activeTab === 'config'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            <Settings size={12} />
            {t('datasets.analysis_config_tab')}
          </button>
        )}
        {!isComponentPlugin && (
          <button
            onClick={() => setActiveTab(activeTab === 'code' ? null : 'code')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              activeTab === 'code'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            <Code2 size={12} />
            {t('datasets.analysis_code_tab')}
            {isCodeCustomized && (
              <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">
                {t('datasets.analysis_code_modified_badge')}
              </Badge>
            )}
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {!isComponentPlugin && (
            <Button
              size="sm"
              onClick={() => handleRun()}
              disabled={isExecuting}
              className="h-6 gap-1 text-xs"
            >
              <Play size={12} />
              {isExecuting ? t('datasets.analysis_running') : t('datasets.analysis_run')}
            </Button>
          )}
          {isCodeCustomized && !isInline && !isComponentPlugin && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleResetCode}
              className="h-6 gap-1 text-xs"
            >
              <RotateCcw size={12} />
              {t('datasets.analysis_reset_code')}
            </Button>
          )}
        </div>
      </div>

      {/* Content: Allotment split */}
      <div className="min-h-0 flex-1">
        <Allotment proportionalLayout={false}>
          <Allotment.Pane preferredSize="45%" minSize={leftVisible ? 200 : 0} visible={leftVisible}>
            <div className="flex h-full flex-col border-r">
              <div className="min-h-0 flex-1 overflow-auto">
                {activeTab === 'config' && hasConfigSchema && (
                  <GenericConfigPanel
                    schema={configSchema as Record<string, PluginConfigField>}
                    config={config}
                    columns={columns}
                    onConfigChange={handleConfigChange}
                    rows={filteredRows}
                    datasetFileId={datasetFileId ?? undefined}
                  />
                )}
                {activeTab === 'code' && (
                  <CodeEditor
                    value={currentCode}
                    language={language}
                    onChange={handleCodeChange}
                    height="100%"
                    editorRef={editorRef}
                    onRunFile={handleRunFile}
                    onRunSelectionOrLine={handleRunSelectionOrLine}
                  />
                )}
              </div>
            </div>
          </Allotment.Pane>

          <Allotment.Pane minSize={200}>
            <SizedPreview widget={widget} gridWidth={gridWidth} widgetSpacing={widgetSpacing}>
              {isComponentPlugin && plugin?.componentId ? (
                <ComponentPluginOutput
                  componentId={plugin.componentId}
                  config={debouncedConfig}
                  columns={columns}
                  rows={filteredRows}
                  datasetFileId={datasetFileId}
                  datasetFilters={datasetFileId ? resolveServerFilters(filters, columns) : undefined}
                />
              ) : (
                <PluginOutputRenderer
                  result={result}
                  isExecuting={isExecuting}
                  statusMessage={statusMessage}
                  installedDeps={installedDeps}
                  onRerun={handleRun}
                  compact
                />
              )}
            </SizedPreview>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sized preview — renders the widget at its on-dashboard pixel size, with a
// drag handle to try other sizes locally (does NOT change the dashboard layout).
// ---------------------------------------------------------------------------

const FALLBACK_GRID_WIDTH = 1400

function SizedPreview({ widget, gridWidth, widgetSpacing, children }: { widget: DashboardWidget; gridWidth?: number; widgetSpacing?: number; children: React.ReactNode }) {
  const { t } = useTranslation()
  const effGridWidth = gridWidth && gridWidth > 0 ? gridWidth : FALLBACK_GRID_WIDTH

  // Cell pitch matching the live dashboard grid (jointive cells), so the preview snaps to whole
  // cells. `gap` stays the per-widget gutter so the snap rounding mirrors widgetPixelSize.
  const { colPitch, rowPitch, gap } = useMemo(() => {
    const g = widgetSpacing ?? DASHBOARD_GRID.margin[0]
    return { colPitch: colWidthFor(effGridWidth), rowPitch: DASHBOARD_GRID.rowHeight, gap: g }
  }, [effGridWidth, widgetSpacing])

  const base = useMemo(
    () => widgetPixelSize(widget.layout.w, widget.layout.h, effGridWidth, widgetSpacing),
    [widget.layout.w, widget.layout.h, effGridWidth, widgetSpacing],
  )
  const [size, setSize] = useState(base)
  // Re-sync to the widget's size when the target widget changes.
  useEffect(() => { setSize(base) }, [base])

  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const [resizing, setResizing] = useState(false)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height }
    setResizing(true)
  }, [size])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const d = dragRef.current
    // Snap the dragged size to whole grid cells, mirroring the dashboard's resize behaviour.
    const rawW = d.startW + (e.clientX - d.startX)
    const rawH = d.startH + (e.clientY - d.startY)
    const cellsW = Math.max(2, Math.round((rawW + gap) / colPitch))
    const cellsH = Math.max(2, Math.round((rawH + gap) / rowPitch))
    setSize({
      width: Math.round(cellsW * colPitch - gap),
      height: Math.round(cellsH * rowPitch - gap),
    })
  }, [colPitch, rowPitch, gap])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    setResizing(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  const isCustomSize = size.width !== base.width || size.height !== base.height
  const cellsW = Math.max(1, Math.round((size.width + gap) / colPitch))
  const cellsH = Math.max(1, Math.round((size.height + gap) / rowPitch))

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-[11px] text-muted-foreground">
        <span>{t('dashboard.preview_size', 'Preview')}: {size.width} × {size.height} px</span>
        {isCustomSize && (
          <button onClick={() => setSize(base)} className="inline-flex items-center gap-1 hover:text-foreground">
            <RotateCcw size={11} />
            {t('dashboard.preview_reset_size', 'Widget size')}
          </button>
        )}
        <span className="ml-auto">{cellsW} × {cellsH} {t('dashboard.preview_cells', 'cells')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
        <div className="relative" style={{ width: size.width, height: size.height }}>
          {/* Red placeholder mirroring the dashboard's resize feedback — the cells the widget will
              occupy. Drawn under the widget so its content stays readable while dragging. */}
          {resizing && (
            <div className="pointer-events-none absolute inset-0 rounded-lg bg-destructive/20" />
          )}
          <div className="h-full w-full overflow-hidden rounded-lg border bg-card shadow-sm">
            {children}
          </div>
          {/* Resize grip (bottom-right) — same glyph as the dashboard widget resize handle. Affects only this preview. */}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className="react-resizable-handle react-resizable-handle-se"
            title={t('dashboard.preview_resize_hint', 'Drag to resize the preview')}
            style={{ cursor: 'nwse-resize' }}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Plugin name badge (mirrors the project/workspace badge style)
// ---------------------------------------------------------------------------

function PluginBadge({ plugin, lang }: { plugin: NonNullable<ReturnType<typeof getPlugin>>; lang: 'en' | 'fr' }) {
  const color = plugin.manifest.iconColor
  const Icon = getLucideIcon(plugin.manifest.icon)
  const name = plugin.manifest.name[lang] ?? plugin.manifest.name.en
  return (
    <Badge
      variant="outline"
      className={cn('gap-1 py-0 text-[11px]', color ? getBadgeClasses(color) : undefined)}
      style={color ? getBadgeStyle(color) : undefined}
    >
      {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
      <Icon size={10} />
      {name}
    </Badge>
  )
}

// ---------------------------------------------------------------------------
// Hook: generate code from plugin template + config
// ---------------------------------------------------------------------------

function useGeneratedCode(
  plugin: ReturnType<typeof getPlugin>,
  config: Record<string, unknown>,
  columns: DatasetColumn[],
  language: 'python' | 'r',
): string {
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!plugin?.templates) {
      setCode('')
      return
    }
    const template = language === 'python' ? plugin.templates.python : plugin.templates.r
    if (!template) {
      setCode('')
      return
    }
    import('@/lib/plugins/template-resolver').then(({ resolveTemplate }) => {
      const resolved = resolveTemplate(
        template,
        config,
        columns,
        plugin.manifest.configSchema,
        language,
      )
      setCode(resolved)
    })
  }, [plugin, config, columns, language])

  return code
}

// ---------------------------------------------------------------------------
// Component plugin output — renders the React component live
// ---------------------------------------------------------------------------

function ComponentPluginOutput({
  componentId,
  config,
  columns,
  rows,
  datasetFileId,
  datasetFilters,
}: {
  componentId: string
  config: Record<string, unknown>
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  datasetFileId?: string | null
  datasetFilters?: unknown[]
}) {
  const { t } = useTranslation()
  const Component = getComponent(componentId)

  if (!Component) {
    return (
      <div className="flex items-center justify-center h-full p-8 text-xs text-muted-foreground">
        Component not found: {componentId}
      </div>
    )
  }

  // Gate in-browser viz in server mode unless the component computes server-side.
  if (isServerMode() && !componentSupportsServer(componentId)) {
    return (
      <div className="flex items-center justify-center h-full p-3 text-center text-xs text-muted-foreground">
        {t('datasets.component_server_unavailable')}
      </div>
    )
  }

  // `compact` matches how the widget renders on the dashboard (full-bleed, no extra chrome).
  return (
    <div className="h-full overflow-hidden">
      <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">…</div>}>
        {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
        <Component
          config={config}
          columns={columns}
          rows={rows}
          compact
          datasetFileId={isServerMode() ? datasetFileId ?? undefined : undefined}
          datasetFilters={isServerMode() && datasetFileId ? datasetFilters : undefined}
        />
      </Suspense>
    </div>
  )
}
