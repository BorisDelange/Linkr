/**
 * The quality report's chart, as an SVG string (see lib/cohort-report/charts.ts:
 * one markup for the HTML, the PDF and the Word file).
 */
import { escapeXml } from '@/lib/cohort-report/charts'
import type { DqCheckStatus } from '@/lib/duckdb/data-quality-checks'
import { scoreOf, type DqTally } from './tally'

/** Status colours: reserved for pass / fail / error, never for a series. The
 *  Results tab paints the same ones. */
export const STATUS_HEX: Record<DqCheckStatus, string> = {
  pass: '#0ca30c',
  fail: '#d03b3b',
  error: '#ec835a',
  not_applicable: '#c3c2b7',
}

/** The statuses in the order a bar stacks them, with the tally field each reads. */
export const STATUS_ORDER: { status: DqCheckStatus; field: keyof Omit<DqTally, 'total'> }[] = [
  { status: 'pass', field: 'passed' },
  { status: 'fail', field: 'failed' },
  { status: 'error', field: 'errors' },
  { status: 'not_applicable', field: 'notApplicable' },
]

const FONT = "font-family=\"system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif\""
const TEXT = '#33445c'
const MUTED = '#667892'
const TRACK = '#eef2f7'

/**
 * One bar per row (a Kahn dimension, a severity), the checks split by status,
 * the score at the end; a legend on top. Each segment has its count in a
 * tooltip (`<title>`); a 2px gap separates them.
 */
export function statusBars(
  rows: { label: string; tally: DqTally }[],
  opts: { title: string; statusLabel: (status: DqCheckStatus) => string; width?: number },
): string {
  const width = opts.width ?? 640
  const rowH = 24
  const legendH = 22
  const labelW = Math.min(180, Math.max(70, ...rows.map((r) => r.label.length * 6.2)))
  const valueW = 48
  const plotW = width - labelW - valueW - 12
  const height = legendH + rows.length * rowH + 4
  const parts: string[] = []

  let lx = labelW
  for (const { status } of STATUS_ORDER) {
    const label = opts.statusLabel(status)
    parts.push(`<rect x="${lx}" y="5" width="10" height="10" rx="2" fill="${STATUS_HEX[status]}" />`)
    parts.push(`<text x="${lx + 14}" y="14" font-size="9.5" fill="${TEXT}">${escapeXml(label)}</text>`)
    lx += 14 + label.length * 5.6 + 16
  }

  rows.forEach((row, i) => {
    const y = legendH + i * rowH
    parts.push(`<text x="${labelW - 6}" y="${y + 15}" font-size="10" text-anchor="end" fill="${TEXT}">${escapeXml(row.label)}</text>`)
    parts.push(`<rect x="${labelW}" y="${y + 5}" width="${plotW}" height="${rowH - 10}" rx="3" fill="${TRACK}" />`)
    const shown = STATUS_ORDER.filter(({ field }) => row.tally[field] > 0)
    const gaps = Math.max(0, shown.length - 1) * 2
    let x = labelW
    for (const { status, field } of shown) {
      const w = row.tally.total ? (row.tally[field] / row.tally.total) * (plotW - gaps) : 0
      parts.push(`<rect x="${x.toFixed(1)}" y="${y + 5}" width="${Math.max(1, w).toFixed(1)}" height="${rowH - 10}" rx="2" fill="${STATUS_HEX[status]}"><title>${escapeXml(`${opts.statusLabel(status)}: ${row.tally[field]}`)}</title></rect>`)
      x += w + 2
    }
    const score = scoreOf(row.tally)
    parts.push(`<text x="${width - 4}" y="${y + 15}" font-size="10" text-anchor="end" fill="${row.tally.total ? TEXT : MUTED}">${score == null ? '—' : `${score}%`}</text>`)
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(opts.title)}" ${FONT}>${parts.join('')}</svg>`
}
