import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import type { Pipeline, PipelineNode, PipelineNodeData, PipelineEdge } from '@/types'

interface PipelineState {
  pipelines: Pipeline[]
  pipelinesLoaded: boolean

  loadPipelines: () => Promise<void>
  getProjectPipelines: (projectUid: string) => Pipeline[]
  getOrCreatePipeline: (projectUid: string) => Promise<Pipeline>

  updatePipeline: (id: string, changes: Partial<Pipeline>) => Promise<void>
  removePipeline: (id: string) => Promise<void>

  // Node operations
  updateNode: (pipelineId: string, nodeId: string, data: Partial<PipelineNodeData>) => Promise<void>
  removeNode: (pipelineId: string, nodeId: string) => Promise<void>

  // Bulk update (for React Flow onNodesChange/onEdgesChange)
  setNodesAndEdges: (pipelineId: string, nodes: PipelineNode[], edges: PipelineEdge[]) => Promise<void>
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  pipelinesLoaded: false,

  loadPipelines: async () => {
    const all = await getStorage().pipelines.getAll()
    set({ pipelines: all, pipelinesLoaded: true })
  },

  getProjectPipelines: (projectUid) =>
    get().pipelines.filter((p) => p.projectUid === projectUid),

  getOrCreatePipeline: async (projectUid) => {
    const existing = get().pipelines.find((p) => p.projectUid === projectUid)
    if (existing) return existing

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const pipeline: Pipeline = {
      id,
      projectUid,
      name: 'Main pipeline',
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().pipelines.create(pipeline)
    set((s) => ({ pipelines: [...s.pipelines, pipeline] }))
    return pipeline
  },

  updatePipeline: async (id, changes) => {
    await getStorage().pipelines.update(id, changes)
    set((s) => ({
      pipelines: s.pipelines.map((p) =>
        p.id === id ? { ...p, ...changes, updatedAt: new Date().toISOString() } : p,
      ),
    }))
  },

  removePipeline: async (id) => {
    await getStorage().pipelines.delete(id)
    set((s) => ({
      pipelines: s.pipelines.filter((p) => p.id !== id),
    }))
  },

  updateNode: async (pipelineId, nodeId, data) => {
    const pipeline = get().pipelines.find((p) => p.id === pipelineId)
    if (!pipeline) return
    const updatedNodes = pipeline.nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
    )
    await getStorage().pipelines.update(pipelineId, { nodes: updatedNodes })
    set((s) => ({
      pipelines: s.pipelines.map((p) =>
        p.id === pipelineId ? { ...p, nodes: updatedNodes, updatedAt: new Date().toISOString() } : p,
      ),
    }))
  },

  removeNode: async (pipelineId, nodeId) => {
    const pipeline = get().pipelines.find((p) => p.id === pipelineId)
    if (!pipeline) return
    const updatedNodes = pipeline.nodes.filter((n) => n.id !== nodeId)
    const updatedEdges = pipeline.edges.filter(
      (e) => e.source !== nodeId && e.target !== nodeId,
    )
    await getStorage().pipelines.update(pipelineId, { nodes: updatedNodes, edges: updatedEdges })
    set((s) => ({
      pipelines: s.pipelines.map((p) =>
        p.id === pipelineId
          ? { ...p, nodes: updatedNodes, edges: updatedEdges, updatedAt: new Date().toISOString() }
          : p,
      ),
    }))
  },

  setNodesAndEdges: async (pipelineId, nodes, edges) => {
    await getStorage().pipelines.update(pipelineId, { nodes, edges })
    set((s) => ({
      pipelines: s.pipelines.map((p) =>
        p.id === pipelineId
          ? { ...p, nodes, edges, updatedAt: new Date().toISOString() }
          : p,
      ),
    }))
  },
}))
