import type { DatasetColumn } from '@/types'

export interface MapSpec {
  lat: string | null
  lon: string | null
  color: string | null
  size: string | null
  label: string | null
  popup: string[]
}

/**
 * Build the map render SPEC (resolved column names + popup fields) sent to
 * POST /execute/render. The server owns the pandas program that extracts the
 * per-row plotting fields — so a viewer can render it without the server running
 * any client-supplied code. Only valid coordinates + a few popup fields cross the
 * wire. Palette/radius resolution stays client-side. Server parity:
 * apps/api/app/services/execution/render/map.py (_MAP_PY).
 */
export function buildMapSpec(columns: DatasetColumn[], config: Record<string, unknown>): MapSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  const name = (id: unknown): string | null => (typeof id === 'string' ? byId.get(id)?.name ?? null : null)
  const popupCols = ((config.popupColumns as string[] | undefined) ?? [])
    .map((id) => ({ id, name: byId.get(id)?.name ?? id }))
    .filter((c) => byId.has(c.id))

  return {
    lat: name(config.latColumn),
    lon: name(config.lonColumn),
    color: name(config.colorColumn),
    size: name(config.sizeColumn),
    label: name(config.labelColumn),
    popup: popupCols.map((c) => c.name),
  }
}
