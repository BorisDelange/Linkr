import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from '@dnd-kit/modifiers'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Workflow,
  Play,
  Square,
  PanelRight,
  Code,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Database,
  History,
  ChevronDown,
  ChevronRight,
  Trash2,
  Eye,
  GripVertical,
  List,
  FileCode,
  Users,
  Activity,
  Table2,
  Power,
  Ban,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import * as duckdbEngine from '@/lib/duckdb/engine'
import { computeDatabaseStats } from '@/lib/duckdb/database-stats'
import { etlNodeTypes, type EtlSourceNodeData, type EtlScriptNodeData, type EtlTargetNodeData } from './etl-nodes'
import type { EtlFile, DatabaseStatsCache } from '@/types'

// ---------------------------------------------------------------------------
// Serial layout (vertical chain, alphabetical order by default)
// ---------------------------------------------------------------------------

const NODE_WIDTH = 200
const NODE_HEIGHT = 60
const VERTICAL_GAP = 80

function layoutSerial(
  scriptIds: string[],
  hasSource: boolean,
  hasTarget: boolean,
): Map<string, { x: number; y: number }> {
  const posMap = new Map<string, { x: number; y: number }>()
  const centerX = 0
  let y = 0

  if (hasSource) {
    posMap.set('__source__', { x: centerX, y })
    y += NODE_HEIGHT + VERTICAL_GAP
  }

  for (const id of scriptIds) {
    posMap.set(id, { x: centerX, y })
    y += NODE_HEIGHT + VERTICAL_GAP
  }

  if (hasTarget) {
    posMap.set('__target__', { x: centerX, y })
  }

  return posMap
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  pipelineId: string
  onSelectFile?: (fileId: string) => void
}

export function EtlPipelineTab({ pipelineId, onSelectFile }: Props) {
  const { t } = useTranslation()
  const { etlPipelines, files, pipelineRunning, scriptStatuses, runHistory, startPipelineRun, stopPipelineRun, setScriptStatus, finishPipelineRun, deleteFile, updateFile } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceDs = dataSources.find((ds) => ds.id === pipeline?.sourceDataSourceId)
  const targetDs = dataSources.find((ds) => ds.id === pipeline?.targetDataSourceId)

  const hasSource = !!pipeline?.sourceDataSourceId
  const hasTarget = !!pipeline?.targetDataSourceId

  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'dag' | 'list'>('list')

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; nodeType: string; fileId?: string } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [contextMenu])

  // Build React Flow nodes & edges — serial chain (alphabetical)
  const { initialNodes, initialEdges, sqlFiles } = useMemo(() => {
    const sqlFiles = files
      .filter((f) => f.type === 'file' && f.language === 'sql')
      .sort((a, b) => a.order - b.order)

    if (sqlFiles.length === 0 && !hasSource && !hasTarget) {
      return { initialNodes: [] as Node[], initialEdges: [] as Edge[], sqlFiles: [] }
    }

    const scriptIds = sqlFiles.map((f) => f.id)
    const posMap = layoutSerial(scriptIds, hasSource, hasTarget)

    const rfNodes: Node[] = []
    const rfEdges: Edge[] = []

    // Source node
    if (hasSource) {
      const pos = posMap.get('__source__') ?? { x: 0, y: 0 }
      rfNodes.push({
        id: '__source__',
        type: 'source',
        position: pos,
        draggable: false,
        data: {
          nodeType: 'source',
          label: t('etl.source'),
          dataSourceName: sourceDs?.name,
        } satisfies EtlSourceNodeData,
      })
    }

    // Script nodes — chained serially
    let prevId = hasSource ? '__source__' : null
    for (let i = 0; i < sqlFiles.length; i++) {
      const file = sqlFiles[i]
      const pos = posMap.get(file.id) ?? { x: 0, y: 0 }
      rfNodes.push({
        id: file.id,
        type: 'script',
        position: pos,
        data: {
          nodeType: 'script',
          label: file.name,
          fileId: file.id,
          order: i + 1,
          status: file.disabled ? 'disabled' : 'idle',
          disabled: file.disabled,
        } satisfies EtlScriptNodeData,
      })
      if (prevId) {
        rfEdges.push({
          id: `chain-${prevId}-${file.id}`,
          source: prevId,
          target: file.id,
          type: 'smoothstep',
          animated: false,
          style: { stroke: 'var(--color-border)', strokeWidth: 1.5 },
        })
      }
      prevId = file.id
    }

    // Target node
    if (hasTarget) {
      const pos = posMap.get('__target__') ?? { x: 0, y: 0 }
      rfNodes.push({
        id: '__target__',
        type: 'target',
        position: pos,
        draggable: false,
        data: {
          nodeType: 'target',
          label: t('etl.target'),
          dataSourceName: targetDs?.name,
        } satisfies EtlTargetNodeData,
      })
      if (prevId) {
        rfEdges.push({
          id: `chain-${prevId}-__target__`,
          source: prevId,
          target: '__target__',
          type: 'smoothstep',
          animated: false,
          style: { stroke: 'var(--color-border)', strokeWidth: 1.5 },
        })
      }
    }

    return { initialNodes: rfNodes, initialEdges: rfEdges, sqlFiles }
  }, [files, hasSource, hasTarget, sourceDs?.name, targetDs?.name, t])

  // Use React Flow state for draggable nodes
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Update nodes when initial data or scriptStatuses change
  useMemo(() => {
    setNodes(initialNodes.map((n) => {
      const data = n.data as unknown as { nodeType: string; fileId?: string }
      if (data.nodeType === 'script' && data.fileId) {
        const log = scriptStatuses.get(data.fileId)
        if (log) {
          return {
            ...n,
            data: { ...n.data, status: log.status, durationMs: log.durationMs, rowsAffected: log.rowsAffected },
          }
        }
      }
      return n
    }))
    setEdges(initialEdges.map((e) => {
      // Animate edges when pipeline is running
      if (pipelineRunning) {
        return { ...e, animated: true }
      }
      return { ...e, animated: false }
    }))
  }, [initialNodes, initialEdges, scriptStatuses, pipelineRunning, setNodes, setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id)
    setSidebarVisible(true)
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    const data = node.data as unknown as { nodeType: string; fileId?: string }
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, nodeType: data.nodeType, fileId: data.fileId })
  }, [])

  const handleContextDelete = useCallback(() => {
    if (!contextMenu?.fileId) return
    deleteFile(contextMenu.fileId)
    setContextMenu(null)
  }, [contextMenu, deleteFile])

  const handleContextViewCode = useCallback(() => {
    if (!contextMenu?.fileId || !onSelectFile) return
    onSelectFile(contextMenu.fileId)
    setContextMenu(null)
  }, [contextMenu, onSelectFile])

  // Run pipeline — execute scripts sequentially
  const handleRunPipeline = useCallback(async () => {
    if (!pipeline?.targetDataSourceId || sqlFiles.length === 0) return
    startPipelineRun()
    const abort = useEtlStore.getState().pipelineRunAbort
    const { testConnection } = useDataSourceStore.getState()

    // Ensure source + target + vocabulary databases are mounted
    if (pipeline.sourceDataSourceId) await testConnection(pipeline.sourceDataSourceId)
    await testConnection(pipeline.targetDataSourceId)

    // Mount any vocabulary reference databases (needed by 00a_vocabulary_tables)
    const allDs = useDataSourceStore.getState().dataSources
    const vocabSources = allDs.filter((ds) => ds.isVocabularyReference && ds.status === 'connected')
    for (const vs of vocabSources) {
      await testConnection(vs.id)
    }

    let hasError = false
    for (const file of sqlFiles) {
      if (abort?.signal.aborted) break
      if (file.disabled || !file.content) {
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'skipped',
        })
        continue
      }

      // Resolve per-file data source or fallback to pipeline target
      const dsId = file.dataSourceId ?? pipeline.targetDataSourceId

      setScriptStatus(file.id, {
        id: `log-${file.id}-${Date.now()}`,
        pipelineId,
        fileId: file.id,
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const start = Date.now()
      try {
        await testConnection(dsId)
        const rows = await duckdbEngine.queryDataSource(dsId, file.content)
        const duration = Date.now() - start
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'success',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: duration,
          rowsAffected: rows.length,
          output: `${rows.length} row${rows.length !== 1 ? 's' : ''} in ${duration}ms`,
        })
      } catch (err) {
        const duration = Date.now() - start
        hasError = true
        setScriptStatus(file.id, {
          id: `log-${file.id}-${Date.now()}`,
          pipelineId,
          fileId: file.id,
          status: 'error',
          startedAt: new Date(start).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: duration,
          error: err instanceof Error ? err.message : String(err),
        })
        // Auto-select the failed node and open sidebar
        setSelectedNodeId(file.id)
        setSidebarVisible(true)
        break
      }
    }

    finishPipelineRun(hasError || abort?.signal.aborted ? 'error' : 'success')
  }, [pipeline, sqlFiles, pipelineId, startPipelineRun, setScriptStatus, finishPipelineRun])

  // Get selected node info for sidebar
  const selectedNodeInfo = useMemo(() => {
    if (!selectedNodeId) return null
    if (selectedNodeId === '__source__') return { type: 'source' as const, ds: sourceDs }
    if (selectedNodeId === '__target__') return { type: 'target' as const, ds: targetDs }
    const file = files.find((f) => f.id === selectedNodeId)
    const log = scriptStatuses.get(selectedNodeId)
    const fileDsId = file?.dataSourceId ?? pipeline?.targetDataSourceId
    const fileDs = dataSources.find((ds) => ds.id === fileDsId)
    return file ? { type: 'script' as const, file, log, ds: fileDs, isOverride: !!file.dataSourceId } : null
  }, [selectedNodeId, sourceDs, targetDs, files, scriptStatuses, dataSources, pipeline?.sourceDataSourceId])

  // Empty state
  if (initialNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Workflow size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.pipeline_empty')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{t('etl.pipeline_empty_hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          {!pipelineRunning ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={handleRunPipeline}>
                  <Play size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.run_pipeline')}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={stopPipelineRun}>
                  <Square size={14} className="text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.stop')}</TooltipContent>
            </Tooltip>
          )}

          <span className="text-xs text-muted-foreground">
            {sqlFiles.length} {t('etl.pipeline_scripts_count')}
          </span>

          {pipelineRunning && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Loader2 size={12} className="animate-spin" />
              {t('etl.status_running')}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setViewMode(viewMode === 'list' ? 'dag' : 'list')}
                >
                  <List size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.pipeline_list_view')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showHistory ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setShowHistory(!showHistory)}
                >
                  <History size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.run_history')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={sidebarVisible ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => setSidebarVisible(!sidebarVisible)}
                >
                  <PanelRight size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('etl.pipeline_toggle_detail')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content: canvas + sidebar */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Allotment proportionalLayout={false}>
            {/* Flow canvas, list, or history */}
            <Allotment.Pane minSize={400}>
              {showHistory ? (
                <RunHistoryPanel
                  runHistory={runHistory}
                  files={files}
                  expandedRunId={expandedRunId}
                  onToggleRun={(id) => setExpandedRunId(expandedRunId === id ? null : id)}
                />
              ) : viewMode === 'list' ? (
                <ScriptOrderList
                  sqlFiles={sqlFiles}
                  sourceDs={sourceDs}
                  targetDs={targetDs}
                  dataSources={dataSources}
                  pipeline={pipeline}
                  scriptStatuses={scriptStatuses}
                  hasSource={hasSource}
                  hasTarget={hasTarget}
                  updateFile={updateFile}
                  onSelectFile={onSelectFile}
                  onSelectNode={(id) => { setSelectedNodeId(id); setSidebarVisible(true) }}
                />
              ) : (
                <div className="h-full w-full">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={etlNodeTypes}
                    onNodesChange={onNodesChange as OnNodesChange<Node>}
                    onEdgesChange={onEdgesChange as OnEdgesChange<Edge>}
                    onNodeClick={onNodeClick}
                    onNodeContextMenu={onNodeContextMenu}
                    onPaneClick={() => setContextMenu(null)}
                    fitView
                    fitViewOptions={{ padding: 0.2, minZoom: 0.15, maxZoom: 1 }}
                    nodesDraggable
                    nodesConnectable={false}
                    elementsSelectable
                    proOptions={{ hideAttribution: true }}
                    minZoom={0.1}
                    maxZoom={2}
                  >
                    <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-muted-foreground)" style={{ opacity: 0.15 }} />
                    <MiniMap
                      className="!bottom-4 !right-4 !rounded-md !border !border-border"
                      style={{ width: 140, height: 100 }}
                      nodeColor={(node) => {
                        const type = (node.data as { nodeType?: string })?.nodeType
                        if (type === 'source') return 'var(--color-teal-500, #14b8a6)'
                        if (type === 'target') return 'var(--color-emerald-500, #10b981)'
                        return 'var(--color-blue-500, #3b82f6)'
                      }}
                      maskColor="rgba(0,0,0,0.08)"
                    />
                  </ReactFlow>
                  {/* Context menu */}
                  {contextMenu && (
                    <div
                      ref={contextMenuRef}
                      className="fixed z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md"
                      style={{ left: contextMenu.x, top: contextMenu.y }}
                    >
                      {contextMenu.nodeType === 'script' && onSelectFile && (
                        <button
                          onClick={handleContextViewCode}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
                        >
                          <Eye size={12} />
                          {t('etl.pipeline_view_code')}
                        </button>
                      )}
                      {contextMenu.nodeType === 'script' && (
                        <button
                          onClick={handleContextDelete}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
                        >
                          <Trash2 size={12} />
                          {t('etl.delete_file')}
                        </button>
                      )}
                      {contextMenu.nodeType !== 'script' && (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('etl.pipeline_no_actions')}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Allotment.Pane>

            {/* Right sidebar — node detail */}
            <Allotment.Pane preferredSize={300} minSize={220} maxSize={450} visible={sidebarVisible}>
              <div className="flex h-full flex-col border-l">
                <NodeDetailSidebar
                  info={selectedNodeInfo}
                  onViewCode={onSelectFile ? (fileId: string) => onSelectFile(fileId) : undefined}
                />
              </div>
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </TooltipProvider>
  )
}

// ---------------------------------------------------------------------------
// Node detail sidebar
// ---------------------------------------------------------------------------

type NodeInfo =
  | { type: 'source'; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined }
  | { type: 'target'; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined }
  | { type: 'script'; file: import('@/types').EtlFile; log: import('@/types').EtlRunLog | undefined; ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined; isOverride: boolean }

function NodeDetailSidebar({ info, onViewCode }: { info: NodeInfo | null; onViewCode?: (fileId: string) => void }) {
  const { t } = useTranslation()

  if (!info) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <Workflow size={24} className="text-muted-foreground/50" />
        <p className="mt-3 text-xs text-muted-foreground">{t('etl.pipeline_click_node')}</p>
      </div>
    )
  }

  if (info.type === 'source' || info.type === 'target') {
    return (
      <DatabaseSidebarDetail
        ds={info.ds}
        label={t(info.type === 'source' ? 'etl.source' : 'etl.target')}
        accentColor={info.type === 'source' ? 'text-teal-500' : 'text-emerald-500'}
      />
    )
  }

  // Script node
  const { file, log, ds: scriptDs, isOverride } = info
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Code size={14} className="text-blue-500" />
          <h3 className="truncate text-xs font-medium">{file.name}</h3>
          {log && <RunStatusIcon status={log.status} />}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3 text-xs">
          <DetailRow label={t('etl.pipeline_script_order')} value={String(file.order)} />
          <DetailRow label={t('etl.pipeline_script_lang')} value={file.language ?? 'sql'} />
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 text-muted-foreground">{t('etl.script_db_label')}</span>
            <span className="flex items-center gap-1 text-right">
              {scriptDs?.name ?? '—'}
              {isOverride && (
                <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-600 dark:text-amber-400">
                  {t('etl.script_db_override')}
                </span>
              )}
            </span>
          </div>

          {log && (
            <div className="space-y-2 border-t pt-3">
              <DetailRow label={t('etl.pipeline_run_status')} value={t(`etl.status_${log.status}`)} />
              {log.durationMs != null && (
                <DetailRow
                  label={t('etl.pipeline_run_duration')}
                  value={log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}
                />
              )}
              {log.rowsAffected != null && (
                <DetailRow label={t('etl.pipeline_run_rows')} value={log.rowsAffected.toLocaleString()} />
              )}
              {log.error && (
                <div className="rounded-md bg-red-500/10 p-2 text-red-600 dark:text-red-400">
                  <p className="text-[10px] font-medium">{t('etl.status_error')}</p>
                  <p className="mt-0.5 font-mono text-[10px]">{log.error}</p>
                </div>
              )}
              {log.output && !log.error && (
                <div className="rounded-md bg-muted p-2">
                  <p className="text-[10px] text-muted-foreground">{log.output}</p>
                </div>
              )}
            </div>
          )}

          {onViewCode && (
            <div className="border-t pt-3">
              <Button variant="outline" size="sm" className="w-full gap-1.5 text-xs" onClick={() => onViewCode(file.id)}>
                <Code size={12} />
                {t('etl.pipeline_view_code')}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Database sidebar detail — rich stats for source/target nodes
// ---------------------------------------------------------------------------

function DatabaseSidebarDetail({
  ds,
  label,
  accentColor,
}: {
  ds: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  label: string
  accentColor: string
}) {
  const { t } = useTranslation()
  const [stats, setStats] = useState<DatabaseStatsCache | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!ds?.id || !ds.schemaMapping) {
      setStats(null)
      return
    }
    let cancelled = false
    setLoading(true)
    computeDatabaseStats(ds.id, ds.schemaMapping).then((result) => {
      if (!cancelled) {
        setStats(result)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [ds?.id, ds?.schemaMapping])

  if (!ds) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Database size={14} className={accentColor} />
            <h3 className="text-xs font-medium">{label}</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-xs text-muted-foreground">{t('etl.pipeline_no_db_selected')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Database size={14} className={accentColor} />
          <h3 className="text-xs font-medium">{label}</h3>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-3">
          {/* Basic info */}
          <div className="space-y-2 text-xs">
            <DetailRow label={t('etl.pipeline_db_name')} value={ds.name} />
            <DetailRow label={t('etl.pipeline_db_engine')} value={ds.connectionConfig?.engine ?? '—'} />
            {ds.schemaMapping?.presetLabel && (
              <DetailRow label={t('etl.pipeline_db_schema')} value={ds.schemaMapping.presetLabel} />
            )}
            <DetailRow label={t('etl.pipeline_db_type')} value={ds.sourceType ?? '—'} />
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              {t('common.loading')}…
            </div>
          )}

          {/* Overview stats */}
          {stats && (
            <>
              <div className="border-t pt-3">
                <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('etl.sidebar_overview')}
                </h4>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border p-2 text-center">
                    <Users size={14} className="mx-auto mb-1 text-blue-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.patientCount.toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_patients')}</div>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <Activity size={14} className="mx-auto mb-1 text-emerald-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.visitCount.toLocaleString()}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_visits')}</div>
                  </div>
                  <div className="rounded-md border p-2 text-center">
                    <Table2 size={14} className="mx-auto mb-1 text-amber-500" />
                    <div className="text-sm font-semibold tabular-nums">{stats.summary.tableCount}</div>
                    <div className="text-[9px] text-muted-foreground">{t('etl.sidebar_tables')}</div>
                  </div>
                </div>
              </div>

              {/* Gender distribution */}
              {(stats.genderDistribution.male > 0 || stats.genderDistribution.female > 0) && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_gender')}
                  </h4>
                  <GenderBar distribution={stats.genderDistribution} />
                </div>
              )}

              {/* Descriptive stats */}
              {stats.descriptiveStats.ageMean != null && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_age_stats')}
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    {stats.descriptiveStats.ageMean != null && (
                      <DetailRow label={t('etl.sidebar_mean')} value={String(stats.descriptiveStats.ageMean)} />
                    )}
                    {stats.descriptiveStats.ageMedian != null && (
                      <DetailRow label={t('etl.sidebar_median')} value={String(stats.descriptiveStats.ageMedian)} />
                    )}
                    {stats.descriptiveStats.ageMin != null && stats.descriptiveStats.ageMax != null && (
                      <DetailRow label={t('etl.sidebar_range')} value={`${stats.descriptiveStats.ageMin} – ${stats.descriptiveStats.ageMax}`} />
                    )}
                    {stats.descriptiveStats.ageQ1 != null && stats.descriptiveStats.ageQ3 != null && (
                      <DetailRow label="IQR" value={`${stats.descriptiveStats.ageQ1} – ${stats.descriptiveStats.ageQ3}`} />
                    )}
                  </div>
                </div>
              )}

              {/* Visit stats */}
              {stats.descriptiveStats.losMean != null && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_visit_stats')}
                  </h4>
                  <div className="space-y-1.5 text-xs">
                    {stats.descriptiveStats.admissionDateMin && stats.descriptiveStats.admissionDateMax && (
                      <DetailRow
                        label={t('etl.sidebar_date_range')}
                        value={`${stats.descriptiveStats.admissionDateMin.slice(0, 10)} → ${stats.descriptiveStats.admissionDateMax.slice(0, 10)}`}
                      />
                    )}
                    {stats.descriptiveStats.losMean != null && (
                      <DetailRow label={`${t('etl.sidebar_los')} (${t('etl.sidebar_mean')})`} value={`${stats.descriptiveStats.losMean} j`} />
                    )}
                    {stats.descriptiveStats.losMedian != null && (
                      <DetailRow label={`${t('etl.sidebar_los')} (${t('etl.sidebar_median')})`} value={`${stats.descriptiveStats.losMedian} j`} />
                    )}
                    {stats.descriptiveStats.visitsPerPatientMean != null && (
                      <DetailRow label={t('etl.sidebar_visits_per_patient')} value={`${stats.descriptiveStats.visitsPerPatientMean} (${t('etl.sidebar_mean')})`} />
                    )}
                  </div>
                </div>
              )}

              {/* Table list with row counts */}
              {stats.tableCounts.length > 0 && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('etl.sidebar_tables')} ({stats.tableCounts.length})
                  </h4>
                  <div className="space-y-0.5">
                    {stats.tableCounts.map((tc) => (
                      <div key={tc.tableName} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/30">
                        <Table2 size={10} className="shrink-0 text-blue-500/60" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={tc.tableName}>{tc.tableName}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{tc.rowCount.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

// Simple gender distribution bar
function GenderBar({ distribution }: { distribution: { male: number; female: number; other: number } }) {
  const total = distribution.male + distribution.female + distribution.other
  if (total === 0) return null
  const malePct = Math.round((distribution.male / total) * 100)
  const femalePct = Math.round((distribution.female / total) * 100)
  const otherPct = 100 - malePct - femalePct

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full">
        {malePct > 0 && <div className="bg-blue-500" style={{ width: `${malePct}%` }} />}
        {femalePct > 0 && <div className="bg-pink-500" style={{ width: `${femalePct}%` }} />}
        {otherPct > 0 && <div className="bg-gray-400" style={{ width: `${otherPct}%` }} />}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
          {distribution.male.toLocaleString()} ({malePct}%)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-pink-500" />
          {distribution.female.toLocaleString()} ({femalePct}%)
        </span>
        {distribution.other > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
            {distribution.other.toLocaleString()} ({otherPct}%)
          </span>
        )}
      </div>
    </div>
  )
}

function RunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'success': return <CheckCircle2 size={12} className="text-emerald-500" />
    case 'error': return <AlertCircle size={12} className="text-red-500" />
    case 'running': return <Loader2 size={12} className="animate-spin text-blue-500" />
    case 'pending': return <Clock size={12} className="text-muted-foreground/50" />
    case 'skipped': return <AlertCircle size={12} className="text-amber-500" />
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Run history panel
// ---------------------------------------------------------------------------

interface RunHistoryPanelProps {
  runHistory: { id: string; startedAt: string; completedAt?: string; status: 'running' | 'success' | 'error'; scripts: import('@/types').EtlRunLog[] }[]
  files: import('@/types').EtlFile[]
  expandedRunId: string | null
  onToggleRun: (id: string) => void
}

function RunHistoryPanel({ runHistory, files, expandedRunId, onToggleRun }: RunHistoryPanelProps) {
  const { t } = useTranslation()
  const fileMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])

  if (runHistory.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <History size={28} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.no_run_history')}</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-2">
        {runHistory.map((run) => {
          const isExpanded = expandedRunId === run.id
          const date = new Date(run.startedAt)
          const successCount = run.scripts.filter((s) => s.status === 'success').length
          const totalCount = run.scripts.length
          return (
            <div key={run.id} className="rounded-md border">
              <button
                onClick={() => onToggleRun(run.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50"
              >
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <RunStatusIcon status={run.status} />
                <span className="flex-1 font-medium">
                  {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground">
                  {successCount}/{totalCount}
                </span>
              </button>
              {isExpanded && (
                <div className="border-t px-3 py-2 space-y-1">
                  {run.scripts.map((script) => {
                    const file = fileMap.get(script.fileId)
                    return (
                      <div key={script.id} className="flex items-center gap-2 text-xs">
                        <RunStatusIcon status={script.status} />
                        <span className={cn('flex-1 truncate font-mono', script.status === 'error' && 'text-red-500')}>
                          {file?.name ?? script.fileId}
                        </span>
                        {script.durationMs != null && (
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {script.durationMs < 1000 ? `${script.durationMs}ms` : `${(script.durationMs / 1000).toFixed(1)}s`}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {run.scripts.some((s) => s.error) && (
                    <div className="mt-2 rounded bg-red-500/10 p-2">
                      {run.scripts.filter((s) => s.error).map((s) => (
                        <p key={s.id} className="font-mono text-[10px] text-red-600 dark:text-red-400">{s.error}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

// ---------------------------------------------------------------------------
// Script order list — drag-and-drop reorderable list view
// ---------------------------------------------------------------------------

interface ScriptOrderListProps {
  sqlFiles: EtlFile[]
  sourceDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  targetDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  dataSources: ReturnType<typeof useDataSourceStore.getState>['dataSources']
  pipeline: import('@/types').EtlPipeline | undefined
  scriptStatuses: Map<string, import('@/types').EtlRunLog>
  hasSource: boolean
  hasTarget: boolean
  updateFile: (id: string, changes: Partial<EtlFile>) => Promise<void>
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
}

function ScriptOrderList({
  sqlFiles,
  sourceDs,
  targetDs,
  dataSources,
  pipeline,
  scriptStatuses,
  hasSource,
  hasTarget,
  updateFile,
  onSelectFile,
  onSelectNode,
}: ScriptOrderListProps) {
  const { t } = useTranslation()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = sqlFiles.findIndex((f) => f.id === active.id)
      const newIndex = sqlFiles.findIndex((f) => f.id === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      const reordered = arrayMove(sqlFiles, oldIndex, newIndex)
      // Persist new order values
      reordered.forEach((file, idx) => {
        if (file.order !== idx) {
          updateFile(file.id, { order: idx })
        }
      })
    },
    [sqlFiles, updateFile],
  )

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-lg space-y-0 p-4">
        {/* Source node (static) */}
          {hasSource && (
            <>
              <button
                onClick={() => onSelectNode('__source__')}
                className="flex w-full items-center gap-3 rounded-lg border-2 border-teal-500/30 bg-card px-3 py-2.5 text-left transition-colors hover:border-teal-500/60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal-500/15">
                  <Database size={16} className="text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.source')}</div>
                  {sourceDs && <div className="text-[10px] text-muted-foreground">{sourceDs.name}</div>}
                </div>
              </button>
              <div className="flex justify-center py-1">
                <div className="h-4 w-px bg-border" />
              </div>
            </>
          )}

          {/* Sortable script list */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sqlFiles.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              {sqlFiles.map((file, idx) => {
                const log = scriptStatuses.get(file.id)
                const fileDsId = file.dataSourceId ?? pipeline?.targetDataSourceId
                const fileDs = dataSources.find((ds) => ds.id === fileDsId)
                return (
                  <SortableScriptRow
                    key={file.id}
                    file={file}
                    index={idx}
                    log={log}
                    fileDs={fileDs}
                    isOverride={!!file.dataSourceId}
                    isLast={idx === sqlFiles.length - 1 && !hasTarget}
                    onSelectFile={onSelectFile}
                    onSelectNode={onSelectNode}
                    onToggleDisabled={(id) => updateFile(id, { disabled: !file.disabled })}
                  />
                )
              })}
            </SortableContext>
          </DndContext>

          {/* Target node (static) */}
          {hasTarget && (
            <>
              {sqlFiles.length > 0 && (
                <div className="flex justify-center py-1">
                  <div className="h-4 w-px bg-border" />
                </div>
              )}
              <button
                onClick={() => onSelectNode('__target__')}
                className="flex w-full items-center gap-3 rounded-lg border-2 border-emerald-500/30 bg-card px-3 py-2.5 text-left transition-colors hover:border-emerald-500/60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/15">
                  <Database size={16} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">{t('etl.target')}</div>
                  {targetDs && <div className="text-[10px] text-muted-foreground">{targetDs.name}</div>}
                </div>
              </button>
            </>
          )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SortableScriptRow — individual draggable script in the list
// ---------------------------------------------------------------------------

function SortableScriptRow({
  file,
  index,
  log,
  fileDs,
  isOverride,
  isLast,
  onSelectFile,
  onSelectNode,
  onToggleDisabled,
}: {
  file: EtlFile
  index: number
  log: import('@/types').EtlRunLog | undefined
  fileDs: ReturnType<typeof useDataSourceStore.getState>['dataSources'][0] | undefined
  isOverride: boolean
  isLast: boolean
  onSelectFile?: (fileId: string) => void
  onSelectNode: (id: string) => void
  onToggleDisabled: (fileId: string) => void
}) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.id })

  const isDisabled = !!file.disabled

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : isDisabled ? 0.45 : 1,
  }

  // Border color based on status
  const borderClass = isDragging
    ? 'border-blue-500 shadow-lg'
    : isDisabled
      ? 'border-muted-foreground/20 hover:border-muted-foreground/40'
      : log?.status === 'success'
        ? 'border-emerald-500/40 hover:border-emerald-500/70'
        : log?.status === 'error'
          ? 'border-red-500/40 hover:border-red-500/70'
          : log?.status === 'running'
            ? 'border-blue-500/50 hover:border-blue-500/80'
            : 'border-blue-500/30 hover:border-blue-500/60'

  // Left accent strip color
  const accentColor = isDisabled
    ? 'bg-muted-foreground/20'
    : log?.status === 'success'
      ? 'bg-emerald-500'
      : log?.status === 'error'
        ? 'bg-red-500'
        : log?.status === 'running'
          ? 'bg-blue-500'
          : 'bg-blue-500/30'

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'flex items-center gap-2 rounded-lg border-2 bg-card px-2 py-2 transition-colors relative overflow-hidden',
          borderClass,
        )}
      >
        {/* Left accent strip */}
        <div className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l-md', accentColor)} />

        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing ml-1"
        >
          <GripVertical size={14} />
        </button>

        {/* Order number */}
        <span className={cn('w-5 shrink-0 text-center text-[10px] font-medium tabular-nums', isDisabled ? 'text-muted-foreground/40' : 'text-muted-foreground')}>
          {index + 1}
        </span>

        {/* Icon */}
        <div className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          isDisabled ? 'bg-muted-foreground/10' : 'bg-blue-500/15',
        )}>
          {isDisabled
            ? <Ban size={14} className="text-muted-foreground/40" />
            : <FileCode size={14} className="text-blue-600 dark:text-blue-400" />
          }
        </div>

        {/* File info */}
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => onSelectNode(file.id)}
        >
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-xs font-medium', isDisabled && 'line-through text-muted-foreground/60')} title={file.name}>{file.name}</span>
            {log && !isDisabled && <RunStatusIcon status={log.status} />}
            {isDisabled && (
              <span className="rounded bg-muted-foreground/10 px-1.5 py-0.5 text-[9px] text-muted-foreground/60">
                {t('etl.disabled')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {fileDs && !isDisabled && (
              <span className="flex items-center gap-1">
                <Database size={9} />
                {fileDs.name}
                {isOverride && (
                  <span className="rounded bg-amber-500/15 px-1 text-[8px] text-amber-600 dark:text-amber-400">
                    {t('etl.script_db_override')}
                  </span>
                )}
              </span>
            )}
            {log?.durationMs != null && !isDisabled && (
              <span>{log.durationMs < 1000 ? `${log.durationMs}ms` : `${(log.durationMs / 1000).toFixed(1)}s`}</span>
            )}
            {log?.rowsAffected != null && !isDisabled && (
              <span>{log.rowsAffected.toLocaleString()} rows</span>
            )}
          </div>
        </button>

        {/* Enable/disable toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onToggleDisabled(file.id)}
              className={cn(
                'shrink-0 rounded p-1 transition-colors',
                isDisabled
                  ? 'text-muted-foreground/30 hover:bg-accent hover:text-foreground'
                  : 'text-emerald-500/60 hover:bg-accent hover:text-emerald-600',
              )}
            >
              <Power size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>{isDisabled ? t('etl.enable_script') : t('etl.disable_script')}</TooltipContent>
        </Tooltip>

        {/* View code button */}
        {onSelectFile && (
          <button
            onClick={() => onSelectFile(file.id)}
            className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
            title={t('etl.pipeline_view_code')}
          >
            <Eye size={12} />
          </button>
        )}
      </div>

      {/* Connector line between items */}
      {!isLast && (
        <div className="flex justify-center py-1">
          <div className={cn('h-4 w-px', isDisabled ? 'bg-border/50' : 'bg-border')} />
        </div>
      )}
    </>
  )
}
