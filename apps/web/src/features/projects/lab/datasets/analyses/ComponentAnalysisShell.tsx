import { useState, useCallback, useEffect, useMemo, useRef, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Settings, Check, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { isServerMode } from '@/lib/api-client'
import { getComponent, componentSupportsServer } from '@/lib/plugins/component-registry'
import type { DatasetAnalysis } from '@/types'

interface ComponentAnalysisShellProps {
  analysis: DatasetAnalysis
  configPanel: (onConfigChange: (changes: Record<string, unknown>) => void) => React.ReactNode
  componentId: string
}

export function ComponentAnalysisShell(props: ComponentAnalysisShellProps) {
  // Remount per analysis so the uncommitted draft below resets cleanly — the
  // same trick the dashboard widget editor uses, and it keeps the re-seed out of
  // an effect.
  return <ComponentAnalysisEditor key={props.analysis.id} {...props} />
}

function ComponentAnalysisEditor({ analysis, configPanel, componentId }: ComponentAnalysisShellProps) {
  const { t } = useTranslation()
  const { files, getFileRows, updateAnalysis, saveAnalysis } = useDatasetStore()

  const [configVisible, setConfigVisible] = useState(true)

  const server = isServerMode()
  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = getFileRows(analysis.datasetFileId)

  // --- Local DRAFT state -----------------------------------------------------
  // Nothing is committed until Save, matching the dashboard widget editor. The
  // preview runs off the draft, so it still reflects uncommitted edits; Cancel
  // restores the last saved config. Re-seeded when the analysis changes.
  const savedConfig = analysis.config
  const [draft, setDraft] = useState<Record<string, unknown>>(savedConfig)

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedConfig),
    [draft, savedConfig],
  )

  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    setDraft((prev) => ({ ...prev, ...changes }))
  }, [])

  // Save commits the draft WITHOUT closing anything — the user keeps editing.
  // "Saved" is a brief transient, then the button greys out until the next edit.
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handleSave = useCallback(() => {
    if (!dirty) return
    updateAnalysis(analysis.id, { config: draft })
    saveAnalysis(analysis.id)
    setSavedFlash(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSavedFlash(false), 1500)
  }, [dirty, draft, analysis.id, updateAnalysis, saveAnalysis])
  useEffect(() => () => clearTimeout(savedTimerRef.current), [])
  // A fresh edit makes the button read "Save" again without an effect: being
  // dirty is itself the signal that the flash no longer applies.
  const justSaved = savedFlash && !dirty

  const handleCancel = useCallback(() => { setDraft(savedConfig) }, [savedConfig])

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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={handleCancel}
            disabled={!dirty}
          >
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
                {configPanel(handleConfigChange)}
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
              <ResizableResult>
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

/**
 * The result at a size the user can try out.
 *
 * Unlike the dashboard's preview there are no grid cells to snap to — an
 * analysis is not laid out on a grid — so this is free-form, and starts filling
 * the pane. Resizing is an inspection aid: it changes nothing that is saved.
 * The dashboard's "557 × 288 px / 25 × 15 cells" bar is deliberately absent,
 * since neither number means anything here.
 */
function ResizableResult({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    // Until the first drag the box is auto-sized to the pane; measure it so the
    // drag continues from what the user currently sees rather than jumping.
    const rect = boxRef.current?.getBoundingClientRect()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: rect?.width ?? 0,
      startH: rect?.height ?? 0,
    }
    setResizing(true)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setSize({
      width: Math.max(160, Math.round(d.startW + (e.clientX - d.startX))),
      height: Math.max(120, Math.round(d.startH + (e.clientY - d.startY))),
    })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    setResizing(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }, [])

  return (
    <div className="h-full overflow-auto bg-muted/30 p-4">
      <div
        ref={boxRef}
        className={cn('relative', size ? '' : 'h-full w-full')}
        style={size ? { width: size.width, height: size.height } : undefined}
      >
        <div className="h-full w-full overflow-auto rounded-lg border bg-card shadow-sm">
          {children}
        </div>
        {size && (
          <button
            onClick={() => setSize(null)}
            className="absolute -top-1 right-4 z-10 inline-flex items-center gap-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground hover:text-foreground"
            title={t('datasets.analysis_reset_size')}
          >
            <RotateCcw size={10} />
          </button>
        )}
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
