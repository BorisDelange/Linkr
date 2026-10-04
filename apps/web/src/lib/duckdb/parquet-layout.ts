import type { RelationSpec, SchemaMapping } from '@/types/schema-mapping'
import { fieldColumn } from '@/lib/schema-classes/spec'

/** A table and the column its rows are looked up by, for one patient. */
export interface LayoutCheck {
  schema?: string
  table: string
  column: string
}

/** How a lookup by that column reads the table's Parquet files (server answer). */
export interface LayoutEntry extends LayoutCheck {
  rowGroups: number
  /** Share of row groups one lookup reads: ~1/n when sorted, ~1 when not. */
  scanFraction: number | null
}

/** Below this many row groups, reading them all costs nothing worth a warning. */
const MIN_ROW_GROUPS = 8
/** A lookup reading more than this share of a table means it is not in patient order. */
const MAX_SCAN_FRACTION = 0.25
/** The server refuses a request asking more (`PARQUET_LAYOUT_MAX_CHECKS`). */
export const MAX_LAYOUT_CHECKS = 40

/**
 * Every table the patient views read by patient, with its patient column: the
 * patient, visit, stay and note tables and each event table, deduplicated.
 */
export function patientLayoutChecks(mapping: SchemaMapping): LayoutCheck[] {
  const specs: (RelationSpec | undefined)[] = [
    mapping.patient,
    mapping.visit,
    mapping.visitDetail,
    mapping.note,
    ...(mapping.events ?? []),
    ...(mapping.drugs ?? []),
  ]
  const out = new Map<string, LayoutCheck>()
  for (const spec of specs) {
    const ref = fieldColumn(spec, 'patient_id')
    if (!ref) continue
    const check: LayoutCheck = { table: ref.table.table, column: ref.column, ...(ref.table.schema ? { schema: ref.table.schema } : {}) }
    out.set(`${check.schema ?? ''}.${check.table}`.toLowerCase(), check)
  }
  return [...out.values()].slice(0, MAX_LAYOUT_CHECKS)
}

/** The tables a patient lookup reads mostly in full, worst first. */
export function unsortedTables(entries: readonly LayoutEntry[]): LayoutEntry[] {
  return entries
    .filter((e) => e.rowGroups >= MIN_ROW_GROUPS && e.scanFraction != null && e.scanFraction > MAX_SCAN_FRACTION)
    .sort((a, b) => (b.scanFraction ?? 0) - (a.scanFraction ?? 0) || b.rowGroups - a.rowGroups)
}
