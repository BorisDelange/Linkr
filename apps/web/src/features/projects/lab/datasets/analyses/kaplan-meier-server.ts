import type { DatasetColumn } from '@/types'

export interface KaplanMeierSpec {
  time: string | null
  event: string | null
  group: string | null
  confidenceLevel: number
}

/**
 * Build the Kaplan-Meier render SPEC (time/event/group column names + confidence
 * level) sent to POST /execute/render. The server owns the pandas/lifelines program
 * that fits survival and prints the same KMResult JSON the client computes from rows
 * — so a viewer can render it without the server running any client-supplied code.
 * Server parity: apps/api/app/services/execution/render/kaplan_meier.py (_KM_PY).
 */
export function buildKaplanMeierSpec(
  columns: DatasetColumn[],
  timeId: string,
  eventId: string,
  groupId: string | null,
  confidenceLevel: number,
): KaplanMeierSpec {
  const byId = new Map(columns.map((c) => [c.id, c]))
  return {
    time: byId.get(timeId)?.name ?? null,
    event: byId.get(eventId)?.name ?? null,
    group: groupId ? byId.get(groupId)?.name ?? null : null,
    confidenceLevel,
  }
}
