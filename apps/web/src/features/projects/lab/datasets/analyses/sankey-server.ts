import type { DatasetColumn } from '@/types'

export interface SankeySpec {
  sourceMode: string
  entity: string | null
  stage: string | null
  order: string | null
  levels: string[]
  path: string | null
  pathSeparator: string
  collapseRepeats: boolean
  excludeNA: boolean
  alignEndStates: boolean
  endNode: string
  minLinkValue: number
  maxLinkValue: number
}

/**
 * Build the Sankey render SPEC (resolved column names + flow options) sent to
 * POST /execute/render. The server owns the pandas program that reconstructs the
 * flows and counts the links into the same {nodes, links, total, error} JSON the
 * client computes from rows — so a viewer can render it without the server running
 * any client-supplied code. Server parity:
 * apps/api/app/services/execution/render/sankey.py (_SANKEY_PY).
 */
export function buildSankeySpec(columns: DatasetColumn[], config: Record<string, unknown>): SankeySpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const name = (id: unknown): string | null => (typeof id === 'string' ? byId.get(id)?.name ?? null : null)

  const sourceMode = (config.sourceMode as string) ?? 'long'
  return {
    sourceMode,
    entity: name(config.entityColumn),
    stage: name(config.stageColumn),
    order: name(config.orderColumn),
    levels: ((config.levelColumns as string[]) ?? []).map((id) => byId.get(id)?.name).filter((n): n is string => !!n),
    path: name(config.pathColumn),
    pathSeparator: (config.pathSeparator as string) ?? ';',
    collapseRepeats: (config.collapseRepeats as boolean) ?? true,
    excludeNA: (config.excludeNA as boolean) ?? true,
    alignEndStates: (config.alignEndStates as boolean) ?? false,
    endNode: ((config.addEndNode as string) ?? '').trim(),
    minLinkValue: Math.max(1, (config.minLinkValue as number) ?? 1),
    maxLinkValue: Math.max(0, (config.maxLinkValue as number) ?? 0),
  }
}
