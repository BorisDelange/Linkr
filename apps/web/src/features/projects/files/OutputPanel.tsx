import { useTranslation } from 'react-i18next'
import { useFileStore, type ExecLanguage, type ExecutionResult } from '@/stores/file-store'
import { X, ImageIcon, TableIcon, FileText, Globe, Trash2, ChevronLeft, ChevronRight, Copy, Code, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OutputTable } from './OutputTable'
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'

export const EXEC_LANGUAGES: ExecLanguage[] = ['python', 'r', 'sql']

export const EXEC_TAB_LABELS: Record<ExecLanguage, string> = {
  python: 'Python',
  r: 'R',
  sql: 'SQL',
}

export function getExecLang(tabId: string): ExecLanguage | null {
  for (const l of EXEC_LANGUAGES) {
    if (tabId === `__exec_${l}__`) return l
  }
  return null
}

export function getTabIcon(type: string) {
  switch (type) {
    case 'figure':
      return <ImageIcon size={12} />
    case 'table':
      return <TableIcon size={12} />
    case 'html':
      return <Globe size={12} />
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
    clearExecutionResultsByLanguage,
  } = useFileStore()

  // Group execution results by language
  const resultsByLang = useMemo(() => {
    const map = new Map<ExecLanguage, number>()
    for (const r of executionResults) {
      map.set(r.language, (map.get(r.language) ?? 0) + 1)
    }
    return map
  }, [executionResults])

  const activeExecLang = activeOutputTab ? getExecLang(activeOutputTab) : null
  const showExecContent = activeExecLang !== null

  // Results for the currently active exec tab
  const currentResults = useMemo(
    () =>
      activeExecLang
        ? executionResults.filter((r) => r.language === activeExecLang)
        : [],
    [executionResults, activeExecLang]
  )

  // Auto-scroll sentinel
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showExecContent || currentResults.length === 0) return
    const timer = setTimeout(() => {
      if (scrollSentinelRef.current) {
        scrollSentinelRef.current.scrollIntoView({ behavior: 'smooth' })
      } else if (scrollAreaRef.current) {
        const viewport = scrollAreaRef.current.querySelector(
          '[data-slot="scroll-area-viewport"]'
        )
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight
        }
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [showExecContent, currentResults.length])

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
          {canScrollLeft && (
            <button
              onClick={() => scrollTabs('left')}
              className="shrink-0 px-0.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft size={12} />
            </button>
          )}
          <div
            ref={tabScrollRef}
            className="flex flex-1 items-center overflow-x-hidden"
            onWheel={(e) => {
              const el = tabScrollRef.current
              if (!el) return
              el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX
            }}
          >
            {outputTabOrder.map((tabId) => {
              const execLang = getExecLang(tabId)
              const isActive = activeOutputTab === tabId

              // Exec tab (Python/R/SQL)
              if (execLang) {
                const count = resultsByLang.get(execLang) ?? 0
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
                    <span>{EXEC_TAB_LABELS[execLang]}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                      {count}
                    </span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        clearExecutionResultsByLanguage(execLang)
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
          {canScrollRight && (
            <button
              onClick={() => scrollTabs('right')}
              className="shrink-0 px-0.5 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronRight size={12} />
            </button>
          )}
          <div className="flex items-center shrink-0 border-l">
            {activeExecLang && (
              <button
                onClick={() => clearExecutionResultsByLanguage(activeExecLang)}
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
          <ScrollArea className="h-full" ref={scrollAreaRef}>
            <div className="p-2 space-y-1">
              {currentResults.map((result) => (
                <ResultCard key={result.id} result={result} />
              ))}
              <div ref={scrollSentinelRef} />
            </div>
          </ScrollArea>
        )}
        {!showExecContent && activeTab?.type === 'figure' && (
          <div className="flex h-full items-center justify-center p-4 bg-white dark:bg-zinc-900">
            {typeof activeTab.content === 'string' &&
            activeTab.content.startsWith('<svg') ? (
              <div
                className="max-w-full max-h-full"
                dangerouslySetInnerHTML={{ __html: activeTab.content }}
              />
            ) : typeof activeTab.content === 'string' &&
              activeTab.content.startsWith('data:image') ? (
              <img
                src={activeTab.content}
                alt={activeTab.label}
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <ImageIcon size={48} className="opacity-30" />
                <p className="text-xs">
                  {String(activeTab.content) || 'Figure'}
                </p>
              </div>
            )}
          </div>
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
            sandbox="allow-scripts allow-same-origin"
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
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResultCard — single execution result with copy + show-code toggle
// ---------------------------------------------------------------------------

function ResultCard({ result }: { result: ExecutionResult }) {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)

  const displayText = showCode ? (result.code ?? '') : result.output
  const hasCode = !!result.code

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(displayText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [displayText])

  return (
    <div
      className={cn(
        'rounded-md border p-3',
        result.success
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-red-500/30 bg-red-500/5'
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium">
          {result.fileName}
        </span>
        <div className="flex items-center gap-1">
          {hasCode && (
            <button
              onClick={() => setShowCode((v) => !v)}
              className={cn(
                'rounded p-1 transition-colors',
                showCode
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
              title={showCode ? t('files.show_output') : t('files.show_code')}
            >
              <Code size={12} />
            </button>
          )}
          <button
            onClick={handleCopy}
            className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            title={t('files.copy')}
          >
            {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>
          <span className="ml-1 text-[10px] text-muted-foreground">
            {new Date(result.timestamp).toLocaleTimeString()}
          </span>
          {result.duration > 0 && (
            <span className="text-[10px] text-muted-foreground">{result.duration}ms</span>
          )}
        </div>
      </div>
      <pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">
        {displayText}
      </pre>
    </div>
  )
}
