import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Construction } from 'lucide-react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  SelectionMode,
  type ReactFlowInstance,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { usePipeline } from './use-pipeline'
import { PipelineToolbar } from './PipelineToolbar'
import { PipelineNodePalette } from './PipelineNodePalette'
import { PipelineNodePanel } from './PipelineNodePanel'
import { DatabaseNode, CohortNode, ScriptsNode, DatasetNode, DashboardNode, GroupNode } from './nodes'
import type { PipelineNodeType, PipelineNodeData } from '@/types'

// Defined outside to prevent re-renders
const nodeTypes = {
  database: DatabaseNode,
  cohort: CohortNode,
  scripts: ScriptsNode,
  dataset: DatasetNode,
  dashboard: DashboardNode,
  group: GroupNode,
}

export function PipelineCanvas() {
  const { t } = useTranslation()
  const {
    pipeline,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    addEdge,
    removeEdge,
    deleteSelectedNodes,
    updateNodeData,
    addScript,
    removeScript,
    reorderScripts,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    setNodeParent,
    dataSources,
    cohorts,
  } = usePipeline()

  const reactFlowRef = useRef<ReactFlowInstance<Node<PipelineNodeData>> | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(true)
  const addCountRef = useRef(0)

  // Handle drop from palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/reactflow-node-type') as PipelineNodeType
      if (!type || !reactFlowRef.current) return

      const position = reactFlowRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      addNode(type, position)
    },
    [addNode],
  )

  // Handle click on palette item (no drag) — offset to avoid stacking
  const onPaletteAdd = useCallback(
    (type: PipelineNodeType) => {
      if (!reactFlowRef.current) return
      const offset = (addCountRef.current % 5) * 40
      addCountRef.current += 1
      const center = reactFlowRef.current.screenToFlowPosition({
        x: window.innerWidth / 2 + offset,
        y: window.innerHeight / 2 + offset,
      })
      addNode(type, center)
    },
    [addNode],
  )

  // Node selection
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      setSelectedNodeId(node.id)
    },
    [setSelectedNodeId],
  )

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [setSelectedNodeId])

  // Handle node drag stop — detect group intersections for parent-child
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: Node<PipelineNodeData>) => {
      if (!reactFlowRef.current) return
      // Don't parent a group inside another group
      if (draggedNode.type === 'group') return

      // Get absolute position of the dragged node via internal node
      const internalNode = reactFlowRef.current.getInternalNode(draggedNode.id)
      const absPos = internalNode?.internals.positionAbsolute ?? draggedNode.position

      const intersecting = reactFlowRef.current.getIntersectingNodes(draggedNode)
      const targetGroup = intersecting.find(
        (n) => n.type === 'group' && n.id !== draggedNode.id,
      )

      if (targetGroup && draggedNode.parentId !== targetGroup.id) {
        // Get absolute position of the target group
        const groupInternal = reactFlowRef.current.getInternalNode(targetGroup.id)
        const groupAbsPos = groupInternal?.internals.positionAbsolute ?? targetGroup.position
        // Calculate position relative to the group
        const relativePos = {
          x: absPos.x - groupAbsPos.x,
          y: absPos.y - groupAbsPos.y,
        }
        setNodeParent(draggedNode.id, targetGroup.id, relativePos)
      } else if (!targetGroup && draggedNode.parentId) {
        // Dragged out of group — use the absolute position
        setNodeParent(draggedNode.id, null, absPos)
      }
    },
    [setNodeParent],
  )

  // Keyboard handler
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = event.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
        deleteSelectedNodes()
      }
    },
    [deleteSelectedNodes],
  )

  // Node panel update handlers
  const handleUpdateLabel = useCallback(
    (label: string) => {
      if (!selectedNodeId) return
      updateNodeData(selectedNodeId, { label })
    },
    [selectedNodeId, updateNodeData],
  )

  const handleUpdateDataSourceId = useCallback(
    (dataSourceId: string) => {
      if (!selectedNodeId) return
      const ds = dataSources.find((d) => d.id === dataSourceId)
      updateNodeData(selectedNodeId, { dataSourceId, label: ds?.name ?? 'Database' })
    },
    [selectedNodeId, dataSources, updateNodeData],
  )

  const handleUpdateCohortId = useCallback(
    (cohortId: string) => {
      if (!selectedNodeId) return
      const cohort = cohorts.find((c) => c.id === cohortId)
      updateNodeData(selectedNodeId, { cohortId, label: cohort?.name ?? 'Cohort' })
    },
    [selectedNodeId, cohorts, updateNodeData],
  )

  const handleUpdateDatasetName = useCallback(
    (datasetName: string) => {
      if (!selectedNodeId) return
      updateNodeData(selectedNodeId, { datasetName, label: datasetName || 'Dataset' })
    },
    [selectedNodeId, updateNodeData],
  )

  return (
    <div className="flex h-full flex-col bg-muted/30" onKeyDown={onKeyDown} tabIndex={0}>
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-800 dark:bg-amber-950">
        <Construction size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t('pipeline.wip_banner')}
        </p>
      </div>
      <PipelineToolbar
        pipeline={pipeline}
        selectedNodeId={selectedNodeId}
        onDeleteSelected={deleteSelectedNodes}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen((v) => !v)}
      />
      <div className="flex flex-1 overflow-hidden">
        {paletteOpen && <PipelineNodePalette onAddNode={onPaletteAdd} />}
        <div className="relative flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(instance) => { reactFlowRef.current = instance }}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            snapToGrid
            snapGrid={[16, 16]}
            defaultEdgeOptions={{ type: 'smoothstep' }}
            proOptions={{ hideAttribution: true }}
            multiSelectionKeyCode="Meta"
            deleteKeyCode={['Delete', 'Backspace']}
            selectionMode={SelectionMode.Partial}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="var(--color-muted-foreground)"
              style={{ opacity: 0.15 }}
            />
            <MiniMap
              nodeColor={(node) => {
                const type = (node.data as PipelineNodeData)?.type
                if (type === 'database') return '#2dd4bf'
                if (type === 'cohort') return '#fb923c'
                if (type === 'scripts') return '#60a5fa'
                if (type === 'dataset') return '#a78bfa'
                if (type === 'dashboard') return '#fbbf24'
                if (type === 'group') return '#94a3b8'
                return '#94a3b8'
              }}
              className="!bottom-4 !right-4 !rounded-lg !border !border-border !bg-card/80"
              style={{ width: 140, height: 100 }}
            />
          </ReactFlow>
        </div>
        {selectedNode && (
          <PipelineNodePanel
            node={selectedNode}
            allNodes={nodes}
            edges={edges}
            dataSources={dataSources}
            cohorts={cohorts}
            onUpdateLabel={handleUpdateLabel}
            onUpdateDataSourceId={handleUpdateDataSourceId}
            onUpdateCohortId={handleUpdateCohortId}
            onUpdateDatasetName={handleUpdateDatasetName}
            onAddEdge={addEdge}
            onRemoveEdge={removeEdge}
            onAddScript={(filePath) => addScript(selectedNode.id, filePath)}
            onRemoveScript={(scriptId) => removeScript(selectedNode.id, scriptId)}
            onReorderScripts={(scripts) => reorderScripts(selectedNode.id, scripts)}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  )
}
