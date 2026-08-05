/**
 * Dataset context for an LLM: the SCHEMA, never the rows.
 *
 * This is the load-bearing safety rule of the copilot. Sending rows would put
 * patient data into a prompt — and with a remote provider, outside the
 * institution. The column metadata the app already stores (type, human label,
 * description, categorical value labels) is enough for the model to pick the
 * right column, so there is never a reason to send data.
 *
 * `valueLabels` is included on purpose: knowing that `sex` holds `M`/`F` and what
 * those mean is schema, not data — it comes from the column's metadata sidecar,
 * not from reading any row.
 */
import type { DatasetColumn } from '@/types'

export interface DatasetContextInput {
  id: string
  name: string
  columns: DatasetColumn[]
  /** Row count is an aggregate, safe to send, and helps the model size things. */
  rowCount?: number
}

/** Categorical codes are only useful up to a point; past that it is noise. */
const MAX_VALUE_LABELS = 12

function columnLine(column: DatasetColumn): string {
  const parts: string[] = [column.type]
  if (column.label && column.label !== column.name) parts.push(`"${column.label}"`)

  let line = `  ${column.name} (${parts.join(', ')})`
  if (column.description) line += ` — ${column.description}`

  const labels = Object.entries(column.valueLabels ?? {})
  if (labels.length) {
    const shown = labels
      .slice(0, MAX_VALUE_LABELS)
      .map(([code, label]) => `${code}=${label}`)
      .join(', ')
    const more = labels.length > MAX_VALUE_LABELS ? `, …+${labels.length - MAX_VALUE_LABELS}` : ''
    line += ` [values: ${shown}${more}]`
  }
  return line
}

/**
 * Schema block for one dataset: id, name, row count, and one line per column.
 * Columns keep their stored order so the model sees them as the user does.
 */
export function datasetContext(dataset: DatasetContextInput): string {
  const header =
    dataset.rowCount != null
      ? `${dataset.id} — ${dataset.name} (${dataset.rowCount} rows)`
      : `${dataset.id} — ${dataset.name}`
  const columns = [...dataset.columns]
    .sort((a, b) => a.order - b.order)
    .map(columnLine)
  return [header, ...columns].join('\n')
}

/** Schema blocks for every dataset available to the current dashboard. */
export function datasetsContext(datasets: DatasetContextInput[]): string {
  if (!datasets.length) return 'No datasets available.'
  return datasets.map(datasetContext).join('\n\n')
}
