/**
 * Reactive DAG engine for marimo notebooks.
 *
 * Builds a dependency graph from cell params (imports) and exports,
 * provides topological sort for execution order, and computes
 * downstream cells that need re-execution when a cell changes.
 */

import type { MarimoCell } from './marimo-parser'

export type CellStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'stale'

/**
 * Build a map of variable name → cell ID that exports it.
 */
function buildExportMap(cells: MarimoCell[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const cell of cells) {
    for (const varName of cell.exports) {
      map.set(varName, cell.id)
    }
  }
  return map
}

/**
 * Build adjacency list: for each cell, which cells depend on it (downstream).
 * Also returns the reverse (upstream) map.
 */
export function buildDependencyGraph(cells: MarimoCell[]): {
  downstream: Map<string, Set<string>>  // cell → cells that depend on it
  upstream: Map<string, Set<string>>    // cell → cells it depends on
} {
  const exportMap = buildExportMap(cells)
  const downstream = new Map<string, Set<string>>()
  const upstream = new Map<string, Set<string>>()

  // Initialize all cells
  for (const cell of cells) {
    downstream.set(cell.id, new Set())
    upstream.set(cell.id, new Set())
  }

  // Build edges: if cell B has param `x`, and cell A exports `x`, then A → B
  for (const cell of cells) {
    for (const param of cell.params) {
      const producerId = exportMap.get(param)
      if (producerId && producerId !== cell.id) {
        downstream.get(producerId)!.add(cell.id)
        upstream.get(cell.id)!.add(producerId)
      }
    }
  }

  return { downstream, upstream }
}

/**
 * Returns cell IDs in topological execution order (Kahn's algorithm).
 * Throws if a cycle is detected.
 */
export function getExecutionOrder(cells: MarimoCell[]): string[] {
  const { upstream } = buildDependencyGraph(cells)
  const exportMap = buildExportMap(cells)

  // Compute in-degree for each cell
  const inDegree = new Map<string, number>()
  for (const cell of cells) {
    let deg = 0
    for (const param of cell.params) {
      const producerId = exportMap.get(param)
      if (producerId && producerId !== cell.id) {
        deg++
      }
    }
    inDegree.set(cell.id, deg)
  }

  // Start with cells that have no dependencies
  const queue: string[] = []
  for (const cell of cells) {
    if (inDegree.get(cell.id) === 0) {
      queue.push(cell.id)
    }
  }

  const order: string[] = []
  const cellMap = new Map(cells.map((c) => [c.id, c]))

  // Build downstream for iteration
  const downstreamMap = new Map<string, Set<string>>()
  for (const cell of cells) {
    downstreamMap.set(cell.id, new Set())
  }
  for (const cell of cells) {
    for (const param of cell.params) {
      const producerId = exportMap.get(param)
      if (producerId && producerId !== cell.id) {
        downstreamMap.get(producerId)!.add(cell.id)
      }
    }
  }

  while (queue.length > 0) {
    const cellId = queue.shift()!
    order.push(cellId)

    for (const depId of downstreamMap.get(cellId) ?? []) {
      const deg = inDegree.get(depId)! - 1
      inDegree.set(depId, deg)
      if (deg === 0) {
        queue.push(depId)
      }
    }
  }

  if (order.length < cells.length) {
    // Cycle detected — find the cells involved
    const inOrder = new Set(order)
    const cycleCells = cells.filter((c) => !inOrder.has(c.id)).map((c) => c.name || c.id)
    throw new Error(`Dependency cycle detected involving: ${cycleCells.join(', ')}`)
  }

  return order
}

/**
 * Given a cell that just ran, return the IDs of all downstream cells
 * that need re-execution (transitive closure), in topological order.
 */
export function getDownstreamCells(cellId: string, cells: MarimoCell[]): string[] {
  const { downstream } = buildDependencyGraph(cells)

  // BFS to collect all transitive downstream cells
  const visited = new Set<string>()
  const queue = [cellId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const depId of downstream.get(current) ?? []) {
      if (!visited.has(depId)) {
        visited.add(depId)
        queue.push(depId)
      }
    }
  }

  if (visited.size === 0) return []

  // Return in topological order (preserve execution ordering)
  try {
    const fullOrder = getExecutionOrder(cells)
    return fullOrder.filter((id) => visited.has(id))
  } catch {
    // If there's a cycle, return what we found in BFS order
    return [...visited]
  }
}

/**
 * Detect dependency cycles. Returns null if no cycle, or the names of
 * cells involved in the cycle.
 */
export function detectCycle(cells: MarimoCell[]): string[] | null {
  try {
    getExecutionOrder(cells)
    return null
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Dependency cycle')) {
      // Extract cell names from the error message
      const match = err.message.match(/involving: (.+)$/)
      return match ? match[1].split(', ') : ['unknown']
    }
    return null
  }
}
