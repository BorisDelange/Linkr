import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import {
  useNodesState,
  useEdgesState,
  addEdge as rfAddEdge,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react'
import { usePipelineStore } from '@/stores/pipeline-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { useCohortStore } from '@/stores/cohort-store'
import type { Pipeline, PipelineNode, PipelineEdge, PipelineNodeData, PipelineNodeType, PipelineScript } from '@/types'

/** Convert stored pipeline nodes to React Flow nodes.
 *  Parents must come before children in the array for React Flow to position them correctly. */
function toRFNodes(nodes: PipelineNode[]): Node<PipelineNodeData>[] {
  const mapped = nodes.map((n) => {
    const rfNode: Node<PipelineNodeData> = {
      id: n.id,
      type: n.data.type,
      position: n.position,
      data: n.data,
    }
    // Parent-child grouping
    if (n.parentId) {
      rfNode.parentId = n.parentId
      rfNode.expandParent = true
    }
    // Group nodes need explicit dimensions
    if (n.data.type === 'group') {
      rfNode.width = n.width ?? 300
      rfNode.height = n.height ?? 200
    }
    return rfNode
  })
  // Sort: parents (groups without parentId) before children
  return sortParentsFirst(mapped)
}

/** Ensure parent nodes come before their children in the array */
function sortParentsFirst(nodes: Node<PipelineNodeData>[]): Node<PipelineNodeData>[] {
  const parentIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId!))
  const parents = nodes.filter((n) => parentIds.has(n.id))
  const others = nodes.filter((n) => !parentIds.has(n.id))
  return [...parents, ...others]
}

/** Convert stored pipeline edges to React Flow edges */
function toRFEdges(edges: PipelineEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: 'smoothstep',
  }))
}

/** Convert React Flow nodes back to storage format */
function fromRFNodes(nodes: Node<PipelineNodeData>[]): PipelineNode[] {
  return nodes.map((n) => {
    const stored: PipelineNode = {
      id: n.id,
      type: n.type ?? 'database',
      position: { x: n.position.x, y: n.position.y },
      data: n.data,
    }
    if (n.parentId) stored.parentId = n.parentId
    if (n.width) stored.width = n.width
    if (n.height) stored.height = n.height
    return stored
  })
}

/** Convert React Flow edges back to storage format */
function fromRFEdges(edges: Edge[]): PipelineEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
  }))
}

const defaultLabels: Record<PipelineNodeType, string> = {
  database: 'Database',
  cohort: 'Cohort',
  scripts: 'Scripts',
  dataset: 'Dataset',
  dashboard: 'Dashboard',
  group: 'Group',
}

export function usePipeline() {
  const { uid } = useParams()
  const {
    pipelinesLoaded,
    loadPipelines,
    getOrCreatePipeline,
    setNodesAndEdges,
    updateNode: storeUpdateNode,
  } = usePipelineStore()
  const { getProjectSources } = useDataSourceStore()
  const { getProjectCohorts } = useCohortStore()

  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PipelineNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Debounce persist ref
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const pipelineRef = useRef(pipeline)
  nodesRef.current = nodes
  edgesRef.current = edges
  pipelineRef.current = pipeline

  // Load pipeline on mount
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    const init = async () => {
      if (!pipelinesLoaded) await loadPipelines()
      const p = await getOrCreatePipeline(uid)
      if (cancelled) return
      setPipeline(p)
      setNodes(toRFNodes(p.nodes))
      setEdges(toRFEdges(p.edges))
    }
    init()
    return () => { cancelled = true }
  }, [uid, pipelinesLoaded, loadPipelines, getOrCreatePipeline, setNodes, setEdges])

  // Debounced persist to IndexedDB after node/edge changes
  const schedulePersist = useCallback(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const p = pipelineRef.current
      if (!p) return
      setNodesAndEdges(p.id, fromRFNodes(nodesRef.current), fromRFEdges(edgesRef.current))
    }, 500)
  }, [setNodesAndEdges])

  // Wrap onNodesChange to trigger persist
  const handleNodesChange: OnNodesChange<Node<PipelineNodeData>> = useCallback(
    (changes) => {
      onNodesChange(changes)
      schedulePersist()
    },
    [onNodesChange, schedulePersist],
  )

  // Wrap onEdgesChange to trigger persist
  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes)
      schedulePersist()
    },
    [onEdgesChange, schedulePersist],
  )

  // Handle new connections
  const onConnect: OnConnect = useCallback(
    (params) => {
      setEdges((eds) => rfAddEdge({ ...params, type: 'smoothstep', id: crypto.randomUUID() }, eds))
      schedulePersist()
    },
    [setEdges, schedulePersist],
  )

  // Add a new node at a given position
  const addNode = useCallback(
    (type: PipelineNodeType, position: { x: number; y: number }) => {
      if (!pipelineRef.current) return
      const id = crypto.randomUUID()
      const newNode: Node<PipelineNodeData> = {
        id,
        type,
        position,
        data: {
          label: defaultLabels[type],
          type,
          status: 'idle',
        },
      }
      // Group nodes need explicit dimensions
      if (type === 'group') {
        newNode.width = 300
        newNode.height = 200
      }
      setNodes((nds) => [...nds, newNode])
      schedulePersist()
      return id
    },
    [setNodes, schedulePersist],
  )

  // Delete all selected nodes (supports multi-selection)
  const deleteSelectedNodes = useCallback(() => {
    const selectedIds = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
    if (selectedNodeId) selectedIds.add(selectedNodeId)
    if (selectedIds.size === 0) return
    setNodes((nds) =>
      nds
        .filter((n) => !selectedIds.has(n.id))
        // Detach children of deleted groups
        .map((n) => {
          if (n.parentId && selectedIds.has(n.parentId)) {
            const { parentId: _removed, expandParent: _exp, ...rest } = n
            return rest
          }
          return n
        }),
    )
    setEdges((eds) => eds.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target)))
    setSelectedNodeId(null)
    schedulePersist()
  }, [selectedNodeId, setNodes, setEdges, schedulePersist])

  // Update node data (for the panel)
  const updateNodeData = useCallback(
    (nodeId: string, data: Partial<PipelineNodeData>) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
      )
      // Persist immediately for config changes (not position drags)
      if (pipelineRef.current) {
        storeUpdateNode(pipelineRef.current.id, nodeId, data)
      }
    },
    [setNodes, storeUpdateNode],
  )

  // Add an edge from the panel (source → target)
  const addEdge = useCallback(
    (source: string, target: string) => {
      const id = crypto.randomUUID()
      setEdges((eds) => rfAddEdge({ id, source, target, type: 'smoothstep' }, eds))
      schedulePersist()
    },
    [setEdges, schedulePersist],
  )

  // Remove an edge by id (from the panel)
  const removeEdge = useCallback(
    (edgeId: string) => {
      setEdges((eds) => eds.filter((e) => e.id !== edgeId))
      schedulePersist()
    },
    [setEdges, schedulePersist],
  )

  // Add a script reference to a scripts node
  const addScript = useCallback(
    (nodeId: string, filePath: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n
          const existing = (n.data.scripts as PipelineScript[] | undefined) ?? []
          const newScript: PipelineScript = {
            id: crypto.randomUUID(),
            filePath,
            displayOrder: existing.length,
          }
          return { ...n, data: { ...n.data, scripts: [...existing, newScript] } }
        }),
      )
      if (pipelineRef.current) {
        const node = nodesRef.current.find((n) => n.id === nodeId)
        if (node) {
          const existing = (node.data.scripts as PipelineScript[] | undefined) ?? []
          const newScript: PipelineScript = {
            id: crypto.randomUUID(),
            filePath,
            displayOrder: existing.length,
          }
          storeUpdateNode(pipelineRef.current.id, nodeId, { scripts: [...existing, newScript] })
        }
      }
    },
    [setNodes, storeUpdateNode],
  )

  // Remove a script by id from a scripts node
  const removeScript = useCallback(
    (nodeId: string, scriptId: string) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== nodeId) return n
          const existing = (n.data.scripts as PipelineScript[] | undefined) ?? []
          const filtered = existing
            .filter((s) => s.id !== scriptId)
            .map((s, i) => ({ ...s, displayOrder: i }))
          return { ...n, data: { ...n.data, scripts: filtered } }
        }),
      )
      if (pipelineRef.current) {
        const node = nodesRef.current.find((n) => n.id === nodeId)
        if (node) {
          const existing = (node.data.scripts as PipelineScript[] | undefined) ?? []
          const filtered = existing
            .filter((s) => s.id !== scriptId)
            .map((s, i) => ({ ...s, displayOrder: i }))
          storeUpdateNode(pipelineRef.current.id, nodeId, { scripts: filtered })
        }
      }
    },
    [setNodes, storeUpdateNode],
  )

  // Reorder scripts in a scripts node (called after dnd-kit sort)
  const reorderScripts = useCallback(
    (nodeId: string, reordered: PipelineScript[]) => {
      const updated = reordered.map((s, i) => ({ ...s, displayOrder: i }))
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, scripts: updated } } : n)),
      )
      if (pipelineRef.current) {
        storeUpdateNode(pipelineRef.current.id, nodeId, { scripts: updated })
      }
    },
    [setNodes, storeUpdateNode],
  )

  // Set or clear parent group for a node
  const setNodeParent = useCallback(
    (nodeId: string, parentId: string | null, relativePosition?: { x: number; y: number }) => {
      setNodes((nds) => {
        const updated = nds.map((n) => {
          if (n.id !== nodeId) return n
          if (parentId) {
            return {
              ...n,
              parentId,
              expandParent: true,
              position: relativePosition ?? n.position,
            }
          }
          // Remove from parent
          const { parentId: _removed, expandParent: _exp, ...rest } = n
          return {
            ...rest,
            position: relativePosition ?? n.position,
          }
        })
        // Re-sort so parents come before children
        return sortParentsFirst(updated)
      })
      schedulePersist()
    },
    [setNodes, schedulePersist],
  )

  // Get the currently selected node
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  // Available data sources and cohorts for the project
  const dataSources = uid ? getProjectSources(uid) : []
  const cohorts = uid ? getProjectCohorts(uid) : []

  return {
    pipeline,
    nodes,
    edges,
    onNodesChange: handleNodesChange,
    onEdgesChange: handleEdgesChange,
    onConnect,
    addNode,
    addEdge,
    removeEdge,
    deleteSelectedNodes,
    updateNodeData,
    setNodeParent,
    addScript,
    removeScript,
    reorderScripts,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    dataSources,
    cohorts,
  }
}
