/**
 * The report's charts, as SVG strings.
 *
 * Generated, not captured from recharts: the same markup goes into the HTML, is
 * printed to PDF, and is rasterised into the Word file, so the three outputs
 * cannot disagree — and nothing has to be mounted to produce them. A suppressed
 * count (`value: null`) keeps its slot on the axis but draws no bar.
 */
import type { ReportCount } from './suppress'

export const CHART_COLORS = {
  bar: '#0084d8',
  barDark: '#004578',
  axis: '#cdd7e3',
  text: '#33445c',
  muted: '#667892',
  box: '#eef6fc',
  boxBorder: '#0084d8',
} as const

const FONT = "font-family=\"system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif\""

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface ChartItem {
  label: string
  count: ReportCount
}

function svg(width: number, height: number, body: string, title: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}" ${FONT}>${body}</svg>`
}

/** Columns over a category axis (months, age bands). Labels thin out when crowded. */
export function verticalBars(items: ChartItem[], opts: { title: string; width?: number; height?: number }): string {
  const width = opts.width ?? 640
  const height = opts.height ?? 240
  const pad = { top: 18, right: 8, bottom: 36, left: 8 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const max = Math.max(1, ...items.map((i) => i.count.value ?? 0))
  const slot = items.length ? plotW / items.length : plotW
  const barW = Math.max(2, slot * 0.72)
  // At most ~12 axis labels, whatever the number of columns.
  const every = Math.max(1, Math.ceil(items.length / 12))
  const parts: string[] = [
    `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="${CHART_COLORS.axis}" />`,
  ]
  items.forEach((item, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2
    const cx = pad.left + i * slot + slot / 2
    if (item.count.value != null && item.count.value > 0) {
      const h = (item.count.value / max) * plotH
      const y = pad.top + plotH - h
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${CHART_COLORS.bar}" />`)
      if (items.length <= 24) {
        parts.push(`<text x="${cx.toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="${CHART_COLORS.text}">${escapeXml(item.count.label)}</text>`)
      }
    }
    if (i % every === 0) {
      parts.push(`<text x="${cx.toFixed(1)}" y="${pad.top + plotH + 14}" font-size="9" text-anchor="middle" fill="${CHART_COLORS.muted}">${escapeXml(item.label)}</text>`)
    }
  })
  return svg(width, height, parts.join(''), opts.title)
}

/** Bars along a label column (sex, care units, event tables), largest first as given. */
export function horizontalBars(items: ChartItem[], opts: { title: string; width?: number }): string {
  const width = opts.width ?? 640
  const rowH = 22
  const labelW = Math.min(220, Math.max(80, ...items.map((i) => i.label.length * 6.2)))
  const valueW = 56
  const height = Math.max(rowH, items.length * rowH) + 8
  const plotW = width - labelW - valueW - 16
  const max = Math.max(1, ...items.map((i) => i.count.value ?? 0))
  const parts = items.map((item, i) => {
    const y = 4 + i * rowH
    const label = item.label.length > 36 ? `${item.label.slice(0, 35)}…` : item.label
    const w = item.count.value ? (item.count.value / max) * plotW : 0
    return [
      `<text x="${labelW - 6}" y="${y + 14}" font-size="10" text-anchor="end" fill="${CHART_COLORS.text}">${escapeXml(label)}</text>`,
      w > 0 ? `<rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="1.5" fill="${CHART_COLORS.bar}" />` : '',
      `<text x="${(labelW + w + 6).toFixed(1)}" y="${y + 14}" font-size="10" fill="${CHART_COLORS.text}">${escapeXml(item.count.label)}</text>`,
    ].join('')
  })
  return svg(width, height, parts.join(''), opts.title)
}

export interface FlowStep {
  label: string
  /** "880 stays · 870 patients", already suppressed and formatted. */
  counts: string
}

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) {
      lines.push(line)
      line = w
    } else {
      line = (line + ' ' + w).trim()
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, maxChars - 1)}…`
    return kept
  }
  return lines
}

/** The inclusion flowchart: one box per step, top to bottom, the count in each. */
export function flowchart(steps: FlowStep[], opts: { title: string; width?: number }): string {
  const width = opts.width ?? 560
  const boxW = width - 40
  const boxH = 58
  const gap = 22
  const height = steps.length * boxH + Math.max(0, steps.length - 1) * gap + 4
  const parts: string[] = []
  steps.forEach((step, i) => {
    const y = 2 + i * (boxH + gap)
    const x = 20
    const last = i === steps.length - 1
    parts.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="${last ? CHART_COLORS.barDark : CHART_COLORS.box}" stroke="${CHART_COLORS.boxBorder}" />`)
    const lines = wrap(step.label, 78, 2)
    const fg = last ? '#ffffff' : CHART_COLORS.text
    lines.forEach((l, j) => {
      parts.push(`<text x="${width / 2}" y="${y + 18 + j * 13}" font-size="11" text-anchor="middle" fill="${fg}">${escapeXml(l)}</text>`)
    })
    parts.push(`<text x="${width / 2}" y="${y + boxH - 9}" font-size="12" font-weight="600" text-anchor="middle" fill="${fg}">${escapeXml(step.counts)}</text>`)
    if (!last) {
      const ax = width / 2
      const ay = y + boxH
      parts.push(`<line x1="${ax}" y1="${ay}" x2="${ax}" y2="${ay + gap - 5}" stroke="${CHART_COLORS.muted}" stroke-width="1.5" />`)
      parts.push(`<path d="M${ax - 4},${ay + gap - 7} L${ax + 4},${ay + gap - 7} L${ax},${ay + gap - 1} Z" fill="${CHART_COLORS.muted}" />`)
    }
  })
  return svg(width, height, parts.join(''), opts.title)
}
