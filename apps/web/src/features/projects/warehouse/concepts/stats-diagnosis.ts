export interface DiagnosisLine {
  label: string
  value: string
}

function scalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function entry(item: unknown): string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return scalar(item)
  const { unit, ...rest } = item as Record<string, unknown>
  const fields = Object.entries(rest).map(([k, v]) => `${k} ${scalar(v)}`).join(' · ')
  return unit === undefined ? fields : fields ? `${scalar(unit)} — ${fields}` : scalar(unit)
}

/**
 * The server's statistics diagnosis as short label/value lines: one per scalar,
 * one per entry of a list (a unit and its figures), "—" for an empty list.
 */
export function diagnosisLines(diagnosis: Record<string, unknown>): DiagnosisLine[] {
  const lines: DiagnosisLine[] = []
  for (const [label, value] of Object.entries(diagnosis)) {
    if (!Array.isArray(value)) {
      lines.push({ label, value: scalar(value) })
    } else if (value.length === 0) {
      lines.push({ label, value: '—' })
    } else {
      for (const item of value) lines.push({ label, value: entry(item) })
    }
  }
  return lines
}
