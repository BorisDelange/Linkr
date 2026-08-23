import { useState, useCallback, useEffect, useMemo, useRef, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Settings, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AnalysisExportMenu } from '@/components/ui/analysis-export-menu'
import type { ExportTable } from '@/lib/table-export'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { getComponent, componentSupportsServer } from '@/lib/plugins/component-registry'
import type { DatasetAnalysis } from '@/types'

interface ComponentAnalysisShellProps {
  analysis: DatasetAnalysis
  /**
   * Renders the config panel. It is handed the DRAFT config, not the saved one:
   * the panel is a controlled form, so showing `analysis.config` would make
   * every control snap back to its saved value the moment it was changed.
   */
  configPanel: (
    onConfigChange: (changes: Record<string, unknown>) => void,
    config: Record<string, unknown>,
  ) => React.ReactNode
  componentId: string
}

/**
 * Where an analysis publishes its tabular form, for the Export menu.
 *
 * A ref rather than a prop: the shell renders the component but does not know
 * what it produced, and the component is several layers down. It writes its
 * table here as a side effect of rendering, and the menu reads it on click —
 * so a chart simply never writes, and the table entries stay hidden.
 */
export const analysisTableRef: { current: (() => ExportTable | null) | null } = { current: null }

export function ComponentAnalysisShell({ analysis, configPanel, componentId }: ComponentAnalysisShellProps) {
  const { t } = useTranslation()
  const { files, getFileRows, updateAnalysis, saveAnalysis } = useDatasetStore()

  const [configVisible, setConfigVisible] = useState(true)
  // The rendered result, for the Export menu's PNG.
  const resultRef = useRef<HTMLDivElement | null>(null)

  const server = isServerMode()
  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = getFileRows(analysis.datasetFileId)

  // --- Local DRAFT state -----------------------------------------------------
  // Nothing is committed until Save, matching the dashboard widget editor. The
  // result runs off the draft, so it reflects uncommitted edits; Cancel restores
  // the last saved config.
  //
  // Drafts are keyed BY ANALYSIS rather than reset on switch, so moving between
  // analyses keeps each one's pending edits — and, more importantly, does not
  // remount the component. A remount would re-run the widget on every switch,
  // which is exactly what the dashboard avoids when "reload widgets on tab
  // switch" is off.
  const savedConfig = analysis.config
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const draft = drafts[analysis.id] ?? savedConfig

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedConfig),
    [draft, savedConfig],
  )

  const setDraft = useCallback(
    (update: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      setDrafts((prev) => ({ ...prev, [analysis.id]: update(prev[analysis.id] ?? savedConfig) }))
    },
    [analysis.id, savedConfig],
  )

  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    setDraft((prev) => ({ ...prev, ...changes }))
  }, [setDraft])

  // The result's size is config like any other, so it rides the same draft:
  // Save keeps the new proportions, Cancel restores the previous ones.
  const handleResize = useCallback(({ widthPct, heightPct }: { widthPct: number; heightPct: number }) => {
    setDraft((prev) => ({
      ...prev,
      [SIZE_KEYS.width]: Math.round(widthPct * 10) / 10,
      [SIZE_KEYS.height]: Math.round(heightPct * 10) / 10,
    }))
  }, [setDraft])

  // Save commits the draft WITHOUT closing anything — the user keeps editing.
  // "Saved" is a brief transient, then the button greys out until the next edit.
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handleSave = useCallback(() => {
    if (!dirty) return
    updateAnalysis(analysis.id, { config: draft })
    saveAnalysis(analysis.id)
    // Drop the draft: `draft` now falls back to the config just committed, so
    // the editor is clean without comparing two copies of the same object.
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[analysis.id]
      return next
    })
    setSavedFlash(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSavedFlash(false), 1500)
  }, [dirty, draft, analysis.id, updateAnalysis, saveAnalysis])
  useEffect(() => () => clearTimeout(savedTimerRef.current), [])
  // A fresh edit makes the button read "Save" again without an effect: being
  // dirty is itself the signal that the flash no longer applies.
  const justSaved = savedFlash && !dirty

  const handleCancel = useCallback(() => {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[analysis.id]
      return next
    })
  }, [analysis.id])

  // Cmd/Ctrl+S saves in place. Kept as a ref so the window listener always calls
  // the latest closure without re-binding every render.
  const saveRef = useRef(handleSave)
  useEffect(() => { saveRef.current = handleSave })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const Component = getComponent(componentId)

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <button
          onClick={() => setConfigVisible(!configVisible)}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            configVisible
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <Settings size={12} />
          {t('datasets.analysis_config_tab')}
        </button>

        <div className="ml-auto flex items-center gap-1">
          <AnalysisExportMenu
            name={analysis.name}
            nodeRef={resultRef}
            getTable={() => analysisTableRef.current?.() ?? null}
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleCancel} disabled={!dirty}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" className="h-6 gap-1 text-xs" onClick={handleSave} disabled={!dirty}>
            {justSaved ? <Check size={12} /> : null}
            {justSaved ? t('common.saved') : t('common.save')}
          </Button>
        </div>
      </div>

      {/* Content: Allotment split */}
      <div className="min-h-0 flex-1">
        <Allotment proportionalLayout={false}>
          {/* Left: Config */}
          <Allotment.Pane preferredSize="35%" minSize={configVisible ? 200 : 0} visible={configVisible}>
            <div className="flex h-full flex-col border-r">
              <div className="min-h-0 flex-1 overflow-auto">
                {configPanel(handleConfigChange, draft)}
              </div>
            </div>
          </Allotment.Pane>

          {/* Right: Live component */}
          <Allotment.Pane minSize={200}>
            {server && !componentSupportsServer(componentId) ? (
              // Components that compute in-browser from all rows are gated in
              // server mode (would pull raw data client-side) until migrated.
              <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
                {t('datasets.component_server_unavailable')}
              </div>
            ) : Component ? (
              <ResizableResult
                widthPct={(draft[SIZE_KEYS.width] as number) ?? 100}
                heightPct={(draft[SIZE_KEYS.height] as number) ?? 100}
                onResize={handleResize}
                contentRef={resultRef}
              >
                <Suspense fallback={<div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">…</div>}>
                  {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
                  <Component
                    config={draft}
                    columns={columns}
                    rows={rows}
                    datasetFileId={server ? analysis.datasetFileId : undefined}
                  />
                </Suspense>
              </ResizableResult>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-xs text-muted-foreground">
                Component not found: {componentId}
              </div>
            )}
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}

/** Config keys holding the result's size, as a PERCENTAGE of the pane. */
const SIZE_KEYS = { width: '__widthPct', height: '__heightPct' } as const
const MIN_PCT = 15

/**
 * The result, at a size the user picks and keeps.
 *
 * The size is stored as a PERCENTAGE of the pane, which is the dashboard's own
 * trick (there, cells out of a fixed 48×40 grid): a proportion cannot overflow
 * its container, so the result stays whole when the window, the sidebar split,
 * or the config panel changes width. Storing pixels would need re-clamping on
 * every one of those, and would still scroll the moment the pane got smaller.
 *
 * It lives in the analysis config, so it is part of the draft — Save keeps the
 * new proportions and Cancel restores the previous ones, with no extra wiring.
 */
function ResizableResult({
  widthPct,
  heightPct,
  onResize,
  contentRef,
  children,
}: {
  widthPct: number
  heightPct: number
  onResize: (size: { widthPct: number; heightPct: number }) => void
  /** The card holding the result — what an image export rasterizes. */
  contentRef?: React.Ref<HTMLDivElement>
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [resizing, setResizing] = useState(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; frameW: number; frameH: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const frame = frameRef.current?.getBoundingClientRect()
    if (!frame || frame.width === 0 || frame.height === 0) return
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: (widthPct / 100) * frame.width,
      startH: (heightPct / 100) * frame.height,
      frameW: frame.width,
      frameH: frame.height,
    }
    setResizing(true)
  }, [widthPct, heightPct])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    // Clamped to [MIN_PCT, 100]: the result can never be dragged past the pane,
    // so there is nothing to scroll to.
    const clamp = (pct: number) => Math.min(100, Math.max(MIN_PCT, pct))
    onResize({
      widthPct: clamp(((d.startW + (e.clientX - d.startX)) / d.frameW) * 100),
      heightPct: clamp(((d.startH + (e.clientY - d.startY)) / d.frameH) * 100),
    })
  }, [onResize])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    setResizing(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  return (
    <div ref={frameRef} className="h-full overflow-hidden bg-muted/30 p-4">
      <div
        className="relative"
        style={{ width: `${widthPct}%`, height: `${heightPct}%`, maxWidth: '100%', maxHeight: '100%' }}
      >
        <div ref={contentRef} className="h-full w-full overflow-auto rounded-lg border bg-card shadow-sm">
          {children}
        </div>
        {resizing && <div className="pointer-events-none absolute inset-0 rounded-lg bg-destructive/10" />}
        {/* The grip is drawn here rather than borrowed from react-grid-layout's
            stylesheet: that CSS is imported by the dashboard and patient-data
            grids, neither of which is mounted on this page, so the handle would
            be invisible. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          title={t('datasets.analysis_resize_hint')}
          className="absolute -bottom-0.5 -right-0.5 size-4 cursor-nwse-resize touch-none"
        >
          <svg viewBox="0 0 16 16" className="size-full text-muted-foreground/60">
            <path d="M15 5 L5 15 M15 10 L10 15" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      </div>
    </div>
  )
}
