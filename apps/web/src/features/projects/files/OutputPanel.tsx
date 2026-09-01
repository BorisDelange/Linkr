import { useTranslation } from 'react-i18next'
import { MarkdownRenderer } from '@/components/editor/MarkdownRenderer'
import { CodeViewer } from '@/components/editor/CodeViewer'
import { useFileStore, type ExecutionResult } from '@/stores/file-store'
import { X, ImageIcon, TableIcon, FileText, Globe, Trash2, ChevronLeft, ChevronRight, Copy, Code, Check, ChevronsUpDown, Package, ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format-helpers'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { OutputTable } from './OutputTable'
import { useEffect, useRef, useState, useCallback } from 'react'
import { AnsiText } from '@/components/AnsiText'
import { stripAnsi } from '@/lib/ansi'
import { FigureViewer } from './FigureViewer'
import { Button } from '@/components/ui/button'
import { useEnvironmentsUiStore } from '@/stores/environments-ui-store'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'

export function getTabIcon(type: string) {
  switch (type) {
    case 'figure':
      return <ImageIcon size={12} />
    case 'table':
      return <TableIcon size={12} />
    case 'html':
      return <Globe size={12} />
    case 'markdown':
      return <FileText size={12} />
    default:
      return <FileText size={12} />
  }
}

interface OutputPanelProps {
  onClose?: () => void
  /** When true, hides the internal tab bar (tabs rendered externally). */
  hideTabBar?: boolean
}

export function OutputPanel({ onClose, hideTabBar }: OutputPanelProps) {
  const { t } = useTranslation()
  const {
    outputTabs,
    activeOutputTab,
    outputTabOrder,
    setActiveOutputTab,
    closeOutputTab,
    reorderAllOutputTabs,
    executionResults,
    clearExecutionResults,
  } = useFileStore()

  const isConsoleTab = activeOutputTab === '__exec_console__'
  const showExecContent = isConsoleTab

  // Follow the console output as it streams, but release the moment the reader
  // scrolls up — see useStickToBottom. Keyed on the last result's TEXT, not just
  // how many results there are: a long run is ONE result whose body keeps
  // growing, so a length-only key never fires while it streams.
  const lastResult = executionResults[executionResults.length - 1]
  const { ref: consoleViewportRef, pinned, scrollToBottom } = useStickToBottom<HTMLDivElement>(
    [executionResults.length, lastResult?.output, lastResult?.running],
    showExecContent,
  )

  // --- Drag/drop for all tabs (unified) ---
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData('output-tab-id', tabId)
    e.dataTransfer.effectAllowed = 'move'
    setDragTabId(tabId)
  }, [])

  const handleTabDragOver = useCallback((e: React.DragEvent, tabId: string) => {
    if (!e.dataTransfer.types.includes('output-tab-id')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetId(tabId)
  }, [])

  const handleTabDragLeave = useCallback(() => {
    setDropTargetId(null)
  }, [])

  const handleTabDrop = useCallback((e: React.DragEvent, targetTabId: string) => {
    e.preventDefault()
    setDropTargetId(null)
    setDragTabId(null)
    const draggedId = e.dataTransfer.getData('output-tab-id')
    if (!draggedId || draggedId === targetTabId) return
    const fromIdx = outputTabOrder.indexOf(draggedId)
    const toIdx = outputTabOrder.indexOf(targetTabId)
    if (fromIdx === -1 || toIdx === -1) return
    reorderAllOutputTabs(fromIdx, toIdx)
  }, [outputTabOrder, reorderAllOutputTabs])

  const handleTabDragEnd = useCallback(() => {
    setDragTabId(null)
    setDropTargetId(null)
  }, [])

  // --- Tab scroll with arrows ---
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollState = useCallback(() => {
    const el = tabScrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = tabScrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, outputTabOrder.length])

  const scrollTabs = useCallback((dir: 'left' | 'right') => {
    const el = tabScrollRef.current
    if (!el) return
    el.scrollBy({ left: dir === 'left' ? -120 : 120, behavior: 'smooth' })
  }, [])

  const activeTab = outputTabs.find((tab) => tab.id === activeOutputTab)

  // --- Early return for empty state (all hooks above) ---
  if (outputTabOrder.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <FileText size={24} className="mx-auto text-muted-foreground/50" />
          <p className="mt-2 text-xs text-muted-foreground">
            {t('files.no_output')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar — hidden when tabs are rendered externally */}
      {!hideTabBar && (
        <div className="flex items-center border-b bg-muted/30">
          <button
            onClick={() => scrollTabs('left')}
            disabled={!canScrollLeft}
            className={cn(
              'shrink-0 px-0.5 py-1.5 transition-colors',
              canScrollLeft
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-muted-foreground/25 cursor-default'
            )}
          >
            <ChevronLeft size={12} />
          </button>
          <div
            ref={tabScrollRef}
            className="flex flex-1 items-center overflow-x-auto scrollbar-none"
          >
            {outputTabOrder.map((tabId) => {
              const isConsole = tabId === '__exec_console__'
              const isActive = activeOutputTab === tabId

              // Console tab (unified execution output)
              if (isConsole) {
                return (
                  <button
                    key={tabId}
                    draggable
                    onDragStart={(e) => handleTabDragStart(e, tabId)}
                    onDragOver={(e) => handleTabDragOver(e, tabId)}
                    onDragLeave={handleTabDragLeave}
                    onDrop={(e) => handleTabDrop(e, tabId)}
                    onDragEnd={handleTabDragEnd}
                    onClick={() => setActiveOutputTab(tabId)}
                    className={cn(
                      'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                      isActive
                        ? 'bg-background text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50',
                      dragTabId === tabId && 'opacity-40',
                      dropTargetId === tabId && dragTabId !== tabId && 'ring-1 ring-inset ring-primary/50'
                    )}
                  >
                    <span>{t('files.console')}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      {executionResults.length}
                    </span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        clearExecutionResults()
                      }}
                      className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                    >
                      <X size={10} />
                    </span>
                  </button>
                )
              }

              // Output tab (figure/table/html/text)
              const tab = outputTabs.find((t) => t.id === tabId)
              if (!tab) return null

              return (
                <button
                  key={tab.id}
                  draggable
                  onDragStart={(e) => handleTabDragStart(e, tab.id)}
                  onDragOver={(e) => handleTabDragOver(e, tab.id)}
                  onDragLeave={handleTabDragLeave}
                  onDrop={(e) => handleTabDrop(e, tab.id)}
                  onDragEnd={handleTabDragEnd}
                  onClick={() => setActiveOutputTab(tab.id)}
                  className={cn(
                    'group flex items-center gap-1.5 border-r px-3 py-1.5 text-xs transition-colors whitespace-nowrap shrink-0',
                    tab.id === activeOutputTab
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50',
                    dragTabId === tab.id && 'opacity-40',
                    dropTargetId === tab.id && dragTabId !== tab.id && 'ring-1 ring-inset ring-primary/50'
                  )}
                >
                  {getTabIcon(tab.type)}
                  <span className="max-w-[120px] truncate" title={tab.label}>{tab.label}</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      closeOutputTab(tab.id)
                    }}
                    className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                  >
                    <X size={10} />
                  </span>
                </button>
              )
            })}
          </div>
          <button
            onClick={() => scrollTabs('right')}
            disabled={!canScrollRight}
            className={cn(
              'shrink-0 px-0.5 py-1.5 transition-colors',
              canScrollRight
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-muted-foreground/25 cursor-default'
            )}
          >
            <ChevronRight size={12} />
          </button>
          <div className="flex items-center shrink-0 border-l">
            {isConsoleTab && (
              <button
                onClick={() => clearExecutionResults()}
                className="px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                title={t('files.clear_output')}
              >
                <Trash2 size={13} />
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {showExecContent && (
          <div className="relative h-full">
            <ScrollArea className="h-full" viewportRef={consoleViewportRef}>
              <div className="p-2 space-y-1">
                {executionResults.map((result, idx) => (
                  <ResultCard
                    key={result.id}
                    result={result}
                    isLatest={idx === executionResults.length - 1}
                  />
                ))}
              </div>
            </ScrollArea>
            {/* Only while detached: says the view is no longer following, and
                takes the reader back without hunting for the bottom. */}
            {!pinned && executionResults.length > 0 && (
              <Button
                size="xs"
                variant="secondary"
                className="absolute bottom-3 right-4 gap-1 shadow-md"
                onClick={scrollToBottom}
              >
                <ArrowDown size={12} />
                {t('files.scroll_to_latest')}
              </Button>
            )}
          </div>
        )}
        {!showExecContent && activeTab?.type === 'figure' && (
          <FigureViewer content={String(activeTab.content ?? '')} label={activeTab.label} />
        )}
        {!showExecContent && activeTab?.type === 'table' && (
          <OutputTable
            headers={(activeTab.content as { headers: string[] })?.headers ?? []}
            rows={(activeTab.content as { rows: string[][] })?.rows ?? []}
          />
        )}
        {!showExecContent && activeTab?.type === 'html' && (
          <iframe
            srcDoc={String(activeTab.content)}
            className="h-full w-full border-0"
            // NO allow-same-origin: a srcDoc iframe inherits our origin; combined with
            // allow-scripts, untrusted widget JS could reach the parent origin
            // (cookies/session/DOM). Plotly/leaflet/DT run fine on allow-scripts alone.
            sandbox="allow-scripts"
            title={activeTab.label}
          />
        )}
        {!showExecContent && activeTab?.type === 'text' && (
          <ScrollArea className="h-full">
            <pre className="p-4 text-xs whitespace-pre-wrap font-mono">
              {String(activeTab.content)}
            </pre>
          </ScrollArea>
        )}
        {!showExecContent && activeTab?.type === 'markdown' && (
          <ScrollArea className="h-full">
            <MarkdownRenderer content={String(activeTab.content)} className="p-4" />
          </ScrollArea>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResultCard — single execution result with copy + show-code toggle
// ---------------------------------------------------------------------------

const COLLAPSED_LINES = 5

function ResultCard({ result, isLatest }: { result: ExecutionResult; isLatest?: boolean }) {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)

  const displayText = showCode ? (result.code ?? '') : result.output
  const hasCode = !!result.code
  const lineCount = displayText.split('\n').length
  // Long enough to be worth folding — independent of position, so the latest
  // result can still be folded by hand while it is shown in full.
  const isLong = lineCount > COLLAPSED_LINES

  // null = follow the position: shown in full while it is the latest result,
  // folded once a newer run supersedes it. Clicking the chevron pins the card
  // open or shut — without that, expanding an old result would be undone the
  // moment the next run arrives and re-evaluates the position.
  const [override, setOverride] = useState<boolean | null>(null)
  const collapsed = override ?? (isLong && !isLatest)
  const toggleCollapsed = useCallback(
    () => setOverride((prev) => !(prev ?? (isLong && !isLatest))),
    [isLong, isLatest],
  )

  const shownText = collapsed
    ? displayText.split('\n').slice(0, COLLAPSED_LINES).join('\n')
    : displayText

  const handleCopy = useCallback(() => {
    // Copy the plain text — strip ANSI colour codes the log may carry.
    navigator.clipboard.writeText(stripAnsi(displayText)).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [displayText])

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          // Padding lives on the inner sections, not here: the header is sticky,
          // and a padded parent would leave a gap above it through which the
          // scrolling text would show. No `overflow-hidden` either — it makes
          // this the sticky ancestor's scroll container and pins the header to
          // the card instead of to the viewport.
          'rounded-md border',
          // Red is for a run that did NOT produce its result (an error, or a Stop,
          // which is !success). A run that only wrote to stderr DID run — in R that
          // is where warnings and messages go — so it gets amber, not the same
          // signal as a failure.
          !result.success
            ? 'border-red-500/30 bg-red-500/5'
            : result.warned
              ? 'border-amber-500/30 bg-amber-500/5'
              : 'border-green-500/30 bg-green-500/5'
        )}
      >
        {/* Sticky, so the run's identity (name, code toggle, copy, time,
            duration) stays visible while reading long output. Two layers: the
            card's tint is 5% opaque, so a single tinted background would let the
            output scroll visibly through the header — an opaque `bg-background`
            sits underneath, the tint on top of it. */}
        <div className="sticky top-0 z-10 rounded-t-md bg-background">
          {/* Padding does NOT vary with `collapsed`: the title and the buttons
              must not shift as a card folds and unfolds. */}
          <div
            className={cn(
              'flex items-center justify-between rounded-t-md px-3 py-2',
              !result.success
                ? 'bg-red-500/5'
                : result.warned
                  ? 'bg-amber-500/5'
                  : 'bg-green-500/5',
            )}
          >
            <div className="flex items-center gap-1.5">
              {isLong && (
                <button
                  onClick={toggleCollapsed}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <ChevronsUpDown size={11} />
                </button>
              )}
              <span className={cn('text-xs font-medium', collapsed && 'text-muted-foreground')}>
                {result.fileName}
              </span>
              {result.interrupted && (
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                  {t('files.interrupted')}
                </span>
              )}
              {collapsed && (
                <span className="text-[10px] text-muted-foreground">
                  ({lineCount} lines)
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {hasCode && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setShowCode((v) => !v)}
                      className={cn(
                        'rounded p-1 transition-colors',
                        showCode
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                      )}
                    >
                      <Code size={12} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{showCode ? t('files.show_output') : t('files.show_code')}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleCopy}
                    className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('files.copy')}</TooltipContent>
              </Tooltip>
              <span className="ml-1 text-[10px] text-muted-foreground">
                {new Date(result.timestamp).toLocaleTimeString()}
              </span>
              {result.running ? (
                <LiveTimer startedAt={result.timestamp} />
              ) : result.duration > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {formatDuration(result.duration)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {/* Body padding lives here now that the card itself is unpadded, and
            matches the header's px-3 so the text lines up under the title. A
            collapsed card renders no body at all, so it takes no padding —
            otherwise the header would sit above an empty strip. */}
        <div className={cn(!collapsed && 'px-3 pb-3')}>
          {!collapsed && (
            showCode ? (
              // Source view: the real editor (read-only), so it keeps the syntax
              // highlighting and layout it had on the left.
              <div className="overflow-hidden rounded border">
                <CodeViewer value={result.code ?? ''} language={result.language} />
              </div>
            ) : (
              <div className="text-xs font-mono text-muted-foreground">
                <AnsiText text={shownText} className="whitespace-pre-wrap break-words" />
                {result.running && <RunningDots label={t('files.running')} />}
              </div>
            )
          )}
          {!showCode && result.installOffer && !result.running && (
            <InstallOfferButton resultId={result.id} offer={result.installOffer} />
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}

/** One-click "install these packages in the managed environment" — opens the
 *  Environments modal on the right tab and queues the declarative install, so a
 *  package installed imperatively in a script gets versioned instead of lost. The
 *  offer clears itself once used, so the button doesn't linger on a done action. */
function InstallOfferButton({
  resultId,
  offer,
}: {
  resultId: string
  offer: { language: 'python' | 'r'; packages: string[] }
}) {
  const { t } = useTranslation()
  const requestInstall = useEnvironmentsUiStore((s) => s.requestInstall)
  const updateExecutionResult = useFileStore((s) => s.updateExecutionResult)
  return (
    <Button
      size="xs"
      variant="outline"
      className="mt-2 gap-1.5"
      onClick={() => {
        requestInstall(offer.language, offer.packages)
        updateExecutionResult(resultId, { installOffer: undefined })
      }}
    >
      <Package size={12} />
      {t('environments.install_in_env', { packages: offer.packages.join(', ') })}
    </Button>
  )
}

// Moved to lib/format-helpers so the ETL views share one duration format;
// re-exported because this module's own consumers import it from here.
export { formatDuration }

/** Live-ticking elapsed time for a still-running result — counts up from the
 *  run's start (its `timestamp`) so the user sees progress in real time. The
 *  cadence adapts: fine (100ms) under a minute for a smooth sub-second read,
 *  then 1s once minutes/hours are what matter. */
function LiveTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt)
  // Sub-minute: fine cadence for a smooth sub-second read; past a minute, 1s is
  // enough. Re-runs the effect only when crossing that threshold, not every tick.
  const fineCadence = elapsed < 60_000
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), fineCadence ? 100 : 1000)
    return () => clearInterval(id)
  }, [startedAt, fineCadence])
  return <span className="text-[10px] tabular-nums text-muted-foreground">{formatDuration(elapsed)}</span>
}

/** Animated "…" appended to a running result's output — a live sign the run is
 *  still in progress. Three dots pulse out of phase (built-in animate-pulse +
 *  staggered delay, so no custom keyframe is needed). */
function RunningDots({ label }: { label: string }) {
  return (
    <span className="ml-0.5 inline-flex align-baseline" aria-label={label}>
      <span className="animate-pulse">.</span>
      <span className="animate-pulse" style={{ animationDelay: '0.2s' }}>.</span>
      <span className="animate-pulse" style={{ animationDelay: '0.4s' }}>.</span>
    </span>
  )
}
