import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
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
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  X,
  Plus,
  GripVertical,
  Database,
  Code,
  UsersRound,
  Table2,
  LayoutDashboard,
  Group,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import type { Node, Edge } from '@xyflow/react'
import type { PipelineNodeData, PipelineNodeType, PipelineScript, DataSource, Cohort } from '@/types'

// --- Type config ---

const typeConfig: Record<PipelineNodeType, {
  icon: React.ComponentType<{ size?: number; className?: string }>
  colorClass: string
  bgClass: string
  labelKey: string
  hasInputs: boolean
  hasOutputs: boolean
}> = {
  database: {
    icon: Database,
    colorClass: 'text-teal-600 dark:text-teal-400',
    bgClass: 'bg-teal-500/15',
    labelKey: 'pipeline.node_database',
    hasInputs: false,
    hasOutputs: true,
  },
  cohort: {
    icon: UsersRound,
    colorClass: 'text-orange-600 dark:text-orange-400',
    bgClass: 'bg-orange-500/15',
    labelKey: 'pipeline.node_cohort',
    hasInputs: true,
    hasOutputs: true,
  },
  scripts: {
    icon: Code,
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-500/15',
    labelKey: 'pipeline.node_scripts',
    hasInputs: true,
    hasOutputs: true,
  },
  dataset: {
    icon: Table2,
    colorClass: 'text-violet-600 dark:text-violet-400',
    bgClass: 'bg-violet-500/15',
    labelKey: 'pipeline.node_dataset',
    hasInputs: true,
    hasOutputs: true,
  },
  dashboard: {
    icon: LayoutDashboard,
    colorClass: 'text-amber-600 dark:text-amber-400',
    bgClass: 'bg-amber-500/15',
    labelKey: 'pipeline.node_dashboard',
    hasInputs: true,
    hasOutputs: false,
  },
  group: {
    icon: Group,
    colorClass: 'text-slate-500 dark:text-slate-400',
    bgClass: 'bg-slate-500/15',
    labelKey: 'pipeline.node_group',
    hasInputs: false,
    hasOutputs: false,
  },
}

// --- Props ---

interface PipelineNodePanelProps {
  node: Node<PipelineNodeData>
  allNodes: Node<PipelineNodeData>[]
  edges: Edge[]
  dataSources: DataSource[]
  cohorts: Cohort[]
  onUpdateLabel: (label: string) => void
  onUpdateDataSourceId: (dataSourceId: string) => void
  onUpdateCohortId: (cohortId: string) => void
  onUpdateDatasetName: (name: string) => void
  onAddEdge: (source: string, target: string) => void
  onRemoveEdge: (edgeId: string) => void
  onAddScript: (filePath: string) => void
  onRemoveScript: (scriptId: string) => void
  onReorderScripts: (scripts: PipelineScript[]) => void
  onClose: () => void
}

// --- Sortable script item ---

function SortableScriptItem({
  script,
  onRemove,
}: {
  script: PipelineScript
  onRemove: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: script.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const ext = script.filePath.split('.').pop() ?? ''
  const extColorMap: Record<string, string> = {
    sql: 'text-blue-500',
    py: 'text-yellow-500',
    r: 'text-green-500',
    R: 'text-green-500',
    js: 'text-amber-500',
    ts: 'text-blue-400',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-1"
    >
      <button
        className="flex shrink-0 cursor-grab items-center text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={12} />
      </button>
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
        {script.filePath}
      </span>
      {ext && (
        <span className={`shrink-0 text-[9px] font-medium uppercase ${extColorMap[ext] ?? 'text-muted-foreground'}`}>
          {ext}
        </span>
      )}
      <button
        onClick={() => onRemove(script.id)}
        className="flex shrink-0 items-center text-muted-foreground/50 hover:text-destructive"
      >
        <X size={11} />
      </button>
    </div>
  )
}

// --- Connection row ---

function ConnectionRow({
  nodeData,
  edgeId,
  onRemove,
}: {
  nodeData: PipelineNodeData
  edgeId: string
  onRemove: (edgeId: string) => void
}) {
  const config = typeConfig[nodeData.type]
  const Icon = config.icon

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1">
      <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${config.bgClass}`}>
        <Icon size={10} className={config.colorClass} />
      </div>
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
        {nodeData.label}
      </span>
      <button
        onClick={() => onRemove(edgeId)}
        className="flex shrink-0 items-center text-muted-foreground/50 hover:text-destructive"
        title="Remove connection"
      >
        <X size={11} />
      </button>
    </div>
  )
}

// --- Main panel ---

export function PipelineNodePanel({
  node,
  allNodes,
  edges,
  dataSources,
  cohorts,
  onUpdateLabel,
  onUpdateDataSourceId,
  onUpdateCohortId,
  onUpdateDatasetName,
  onAddEdge,
  onRemoveEdge,
  onAddScript,
  onRemoveScript,
  onReorderScripts,
  onClose,
}: PipelineNodePanelProps) {
  const { t } = useTranslation()
  const nodeData = node.data
  const config = typeConfig[nodeData.type]
  const Icon = config.icon

  // --- Connections ---

  const inputEdges = edges.filter((e) => e.target === node.id)
  const outputEdges = edges.filter((e) => e.source === node.id)

  const connectedInputIds = new Set(inputEdges.map((e) => e.source))
  const connectedOutputIds = new Set(outputEdges.map((e) => e.target))

  // Available nodes for adding new connections (not already connected, not self)
  const availableInputNodes = allNodes.filter(
    (n) => n.id !== node.id && !connectedInputIds.has(n.id),
  )
  const availableOutputNodes = allNodes.filter(
    (n) => n.id !== node.id && !connectedOutputIds.has(n.id),
  )

  const handleAddInput = useCallback(
    (sourceId: string) => {
      if (sourceId) onAddEdge(sourceId, node.id)
    },
    [onAddEdge, node.id],
  )

  const handleAddOutput = useCallback(
    (targetId: string) => {
      if (targetId) onAddEdge(node.id, targetId)
    },
    [onAddEdge, node.id],
  )

  // --- Scripts ---

  const scripts = (nodeData.scripts as PipelineScript[] | undefined) ?? []
  const [newScriptPath, setNewScriptPath] = useState('')

  const handleAddScript = useCallback(() => {
    const trimmed = newScriptPath.trim()
    if (!trimmed) return
    onAddScript(trimmed)
    setNewScriptPath('')
  }, [newScriptPath, onAddScript])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = scripts.findIndex((s) => s.id === active.id)
      const newIndex = scripts.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      onReorderScripts(arrayMove(scripts, oldIndex, newIndex))
    },
    [scripts, onReorderScripts],
  )

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-border bg-card/95">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Icon size={14} className={config.colorClass} />
          <span className="text-xs font-semibold text-foreground">
            {t(config.labelKey)}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* Label */}
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">{t('pipeline.node_label')}</Label>
          <Input
            value={nodeData.label}
            onChange={(e) => onUpdateLabel(e.target.value)}
            className="h-8 text-xs"
          />
        </div>

        <Separator />

        {/* Connections — Inputs */}
        {config.hasInputs && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">
              {t('pipeline.connections_inputs')}
            </Label>
            <div className="space-y-1">
              {inputEdges.map((edge) => {
                const sourceNode = allNodes.find((n) => n.id === edge.source)
                if (!sourceNode) return null
                return (
                  <ConnectionRow
                    key={edge.id}
                    nodeData={sourceNode.data}
                    edgeId={edge.id}
                    onRemove={onRemoveEdge}
                  />
                )
              })}
            </div>
            {availableInputNodes.length > 0 && (
              <select
                value=""
                onChange={(e) => handleAddInput(e.target.value)}
                className="flex h-7 w-full rounded-md border border-dashed border-border bg-transparent px-2 text-[11px] text-muted-foreground outline-none hover:border-border hover:bg-muted/50 focus:ring-1 focus:ring-ring"
              >
                <option value="">{t('pipeline.connections_add_input')}</option>
                {availableInputNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.data.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Connections — Outputs */}
        {config.hasOutputs && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">
              {t('pipeline.connections_outputs')}
            </Label>
            <div className="space-y-1">
              {outputEdges.map((edge) => {
                const targetNode = allNodes.find((n) => n.id === edge.target)
                if (!targetNode) return null
                return (
                  <ConnectionRow
                    key={edge.id}
                    nodeData={targetNode.data}
                    edgeId={edge.id}
                    onRemove={onRemoveEdge}
                  />
                )
              })}
            </div>
            {availableOutputNodes.length > 0 && (
              <select
                value=""
                onChange={(e) => handleAddOutput(e.target.value)}
                className="flex h-7 w-full rounded-md border border-dashed border-border bg-transparent px-2 text-[11px] text-muted-foreground outline-none hover:border-border hover:bg-muted/50 focus:ring-1 focus:ring-ring"
              >
                <option value="">{t('pipeline.connections_add_output')}</option>
                {availableOutputNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.data.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {(config.hasInputs || config.hasOutputs) && <Separator />}

        {/* Type-specific config */}
        {nodeData.type === 'database' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('pipeline.select_database')}</Label>
            <select
              value={nodeData.dataSourceId ?? ''}
              onChange={(e) => onUpdateDataSourceId(e.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t('pipeline.select_database_placeholder')}</option>
              {dataSources.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {nodeData.type === 'cohort' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('pipeline.select_cohort')}</Label>
            <select
              value={nodeData.cohortId ?? ''}
              onChange={(e) => onUpdateCohortId(e.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t('pipeline.select_cohort_placeholder')}</option>
              {cohorts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {nodeData.type === 'dataset' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('pipeline.dataset_name')}</Label>
            <Input
              value={nodeData.datasetName ?? ''}
              onChange={(e) => onUpdateDatasetName(e.target.value)}
              placeholder={t('pipeline.dataset_name_placeholder')}
              className="h-8 text-xs"
            />
          </div>
        )}

        {/* Scripts section (for scripts nodes) */}
        {nodeData.type === 'scripts' && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-muted-foreground">
                {t('pipeline.scripts_title')}
                {scripts.length > 0 && (
                  <span className="ml-1 text-[10px]">({scripts.length})</span>
                )}
              </Label>
            </div>

            {scripts.length === 0 ? (
              <p className="text-[10px] text-muted-foreground/70">
                {t('pipeline.scripts_empty')}
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={scripts.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {scripts.map((script) => (
                      <SortableScriptItem
                        key={script.id}
                        script={script}
                        onRemove={onRemoveScript}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}

            {/* Add script input */}
            <div className="flex gap-1">
              <Input
                value={newScriptPath}
                onChange={(e) => setNewScriptPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddScript()
                }}
                placeholder={t('pipeline.scripts_file_path_placeholder')}
                className="h-7 flex-1 text-[11px]"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={handleAddScript}
                disabled={!newScriptPath.trim()}
              >
                <Plus size={12} />
              </Button>
            </div>
          </div>
        )}

        {nodeData.type === 'dashboard' && (
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">{t('pipeline.dashboard_placeholder_msg')}</Label>
            <p className="text-[10px] text-muted-foreground/70">{t('pipeline.dashboard_editor_phase2')}</p>
          </div>
        )}

        {/* Status info */}
        {nodeData.status !== 'idle' && (
          <>
            <Separator />
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t('pipeline.node_status')}</Label>
              <span className="text-xs text-foreground capitalize">{nodeData.status}</span>
              {nodeData.error && (
                <p className="mt-1 text-[10px] text-destructive">{nodeData.error}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
