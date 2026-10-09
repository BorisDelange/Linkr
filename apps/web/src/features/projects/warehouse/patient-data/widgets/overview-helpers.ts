import { sameWords, hourlyRate, unitIsRate, type OverviewConceptRow } from './overview-layout'
import { fmtValue, fmtDuration as fmtDur, fmtStamp } from './event-format'
import { type TipContent } from './overview-popups'
import { rowLabel } from './overview-row-label'
import { type Mark, type LayoutRow, type BarHit } from './overview-draw'

export interface UnitStay {
  start: number
  end: number | null
  name: string
  category: string | null
}

/** Whole-record density for the range selector's background. */
export interface OverviewDensity {
  counts: Float64Array
  max: number
}

/** Buckets in the range selector's histogram — enough for a smooth strip. */
export const RANGE_BUCKETS = 240

/** Per-source-table colours, assigned by position so any schema gets a palette. */
export const TABLE_PALETTE = [
  '#2563eb', '#7c3aed', '#0891b2', '#dc2626',
  '#db2777', '#ea580c', '#16a34a', '#0f766e',
]
export const UNIT_PALETTE = ['#0f766e', '#7c3aed', '#b45309', '#be123c', '#1d4ed8', '#4d7c0f', '#a21caf', '#0369a1']

export const FOOT = 30
export const RANGE_H = 46
export const GUTTER_MAX = 320

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export function stableColour(name: string, palette: string[]): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The concept's identifiers on one muted line: the id, then the vocabulary code.
 * Either may be missing — MIMIC's d_items has no code column — so the separator
 * only appears between two present values.
 */
function conceptRef(id?: string | null, code?: string | null): string | null {
  return [id, code].filter(Boolean).join(' · ') || null
}

export function setOffsetFromBar(bar: BarHit, thumbTop: number, offsets: Map<string, number>): void {
  const travel = bar.trackH - bar.thumbH
  const frac = travel > 0 ? clamp((thumbTop - bar.trackY) / travel, 0, 1) : 0
  offsets.set(bar.key, Math.round(frac * bar.max))
}

export function unitCount(units: UnitStay[]): number {
  return new Set(units.map((u) => u.name)).size
}

/**
 * Tooltip content for whatever is under the cursor.
 *
 * In the gutter it answers "what is this row, and what did the label say before
 * it was cut". Over the plot it names the exact event, with its value and unit —
 * or, on a density band, the bucket's count and whether zooming would reveal
 * the values.
 */
export function describeHit(
  hit: LayoutRow,
  px: number,
  py: number,
  inGutter: boolean,
  view: { lo: number; hi: number },
  t: (k: string, o?: Record<string, unknown>) => string,
  conceptsById: Map<string, OverviewConceptRow>,
): Omit<TipContent, 'x' | 'y'> | null {
  const label = rowLabel(hit.row, t)

  if (inGutter) {
    // The full name matters most when the gutter had to truncate it.
    const nEvents = Number(hit.row.eventCount)
    const events = `${fmtN(hit.row.eventCount)} ${
      nEvents === 1 ? t('patient_data.overview_events_one') : t('patient_data.overview_events')
    }`
    const nConcepts = hit.row.kind === 'concept' ? 0 : Number(hit.row.conceptCount)
    const counts =
      hit.row.kind === 'concept'
        ? events
        : `${fmtN(hit.row.conceptCount)} ${
            nConcepts === 1
              ? t('patient_data.overview_concepts_one')
              : t('patient_data.overview_concepts')
          } · ${events}`
    const lines = [counts]
    if (hit.row.kind === 'concept' && hit.row.unit) lines.push(hit.row.unit)
    // Show the original name only when shortening actually dropped something.
    // Comparing the raw strings would show it for every drug, since reordering
    // "Oral Tablet" into ", oral tablet" changes the text without hiding a word.
    const full = hit.row.kind === 'concept' ? hit.row.label : label
    if (!sameWords(full, label)) lines.unshift(full)
    return { title: label, code: conceptRef(hit.row.conceptId, hit.row.conceptCode), lines }
  }

  // Individual marks: name the event under the cursor.
  if (hit.marks) {
    let best: Mark | null = null
    let bestD = Infinity
    for (const m of hit.marks) {
      if (px >= m.x0 && px <= m.x1 && py >= m.y0 && py <= m.y1) {
        best = m
        bestD = 0
        break
      }
      // Distance to the mark's EDGE, not its centre: a stay bar can be hundreds
      // of pixels wide, and measuring from its centre puts the cursor "far" from
      // a bar it is sitting right next to.
      const d = px < m.x0 ? m.x0 - px : px > m.x1 ? px - m.x1 : 0
      if (d < bestD) {
        bestD = d
        best = m
      }
    }
    if (best && bestD <= 6) {
      if (best.unit) {
        const u = best.unit
        const when =
          u.end != null
            ? `${fmtStamp(u.start)} → ${fmtStamp(u.end)} · ${fmtDur(u.end - u.start)}`
            : fmtStamp(u.start)
        // The ward's name is the headline — it is what the row exists to answer.
        const lines = [when]
        if (u.category && u.category !== u.name) lines.push(u.category)
        return { title: label, value: u.name, lines }
      }
      if (best.event) {
        const e = best.event
        // A number is only meaningful next to the concept it measures. On an
        // aggregate row ("Other", a concept class) the dot stands for many
        // concepts with different units, so `hit.row.unit` is not this event's
        // unit and the bare figure — 12.5 of what? — says nothing.
        const unit = hit.row.unit ?? ''
        const rate = hourlyRate(e.value, e.start, e.end)
        const total = e.value != null ? `${fmtValue(e.value)}${unit ? ` ${unit}` : ''}` : null
        // Dose and rate read as one fact — "500 mg · 55.56 mg/h" — because for an
        // infusion neither answers the question alone. The rate stays an average
        // over the recorded window, which is why the route sits below it.
        // A value already expressed per hour must not be divided by the duration
        // a second time — that prints a confidently wrong "mL/h".
        // A rate the source recorded beats one derived from the window.
        const dose =
          total && e.rate != null
            ? `${total} · ${fmtValue(e.rate)}${e.rateUnit ? ` ${e.rateUnit}` : ''}`
            : total && rate != null && !unitIsRate(unit)
              ? `${total} · ${fmtValue(rate)} ${unit}/h`
              : total
        const value = hit.row.mixed ? undefined : (dose ?? e.text ?? undefined)
        const when =
          e.end != null
            ? `${fmtStamp(e.start)} → ${fmtStamp(e.end)} · ${fmtDur(e.end - e.start)}`
            : fmtStamp(e.start)
        const lines = [when]
        // The route is what tells a drip from a single shot: the standard
        // vocabulary calls both "Intravenous", so the reader judges, not the code.
        if (e.route) lines.push(e.route)
        // On a class/domain row the table name only repeats the header. What is
        // actually unknown is how much this single dot stands for.
        const merged = best.merged
        let title = label
        let code = conceptRef(hit.row.conceptId, hit.row.conceptCode)
        if (hit.row.mixed && (!merged || merged.length === 1) && e.conceptId) {
          // One event on an aggregate row: with the figure suppressed, name the
          // concept it belongs to — that is what the row itself cannot show.
          const c = conceptsById.get(String(e.conceptId))
          if (c) {
            title = c.conceptName
            code = conceptRef(c.conceptId, c.conceptCode)
          }
        }
        if (merged && merged.length > 1) {
          const concepts = new Set(merged.map((m) => m.conceptId).filter(Boolean)).size
          const events = `${fmtN(merged.length)} ${
            merged.length === 1
              ? t('patient_data.overview_events_one')
              : t('patient_data.overview_events')
          }`
          lines.push(
            concepts > 1
              ? `${events} · ${fmtN(concepts)} ${t('patient_data.overview_concepts')}`
              : events,
          )
        }
        return { title, code, value, lines }
      }
    }
    return null
  }

  // Density band: the bucket count, and whether zooming would help.
  if (hit.counts) {
    const b = Math.floor((px - hit.plotL) / hit.bw)
    const n = b >= 0 && b < hit.nb ? hit.counts[b] : 0
    if (!n) return null
    const span = view.hi - view.lo
    const t0 = view.lo + (b * span) / hit.nb
    const t1 = view.lo + ((b + 1) * span) / hit.nb
    const unit = n > 1 ? t('patient_data.overview_events') : t('patient_data.overview_events_one')
    // A category row aggregates concepts, so it stays a band at every zoom —
    // promising that zooming reveals values would be a lie.
    const hint = hit.row.mixed
      ? t('patient_data.overview_open_category')
      : t('patient_data.overview_zoom_hint')
    return {
      title: label,
      value: `${fmtN(n)} ${unit}`,
      lines: [`${fmtStamp(t0)} → ${fmtStamp(t1)}`, hint],
    }
  }
  return null
}

/** DuckDB counts arrive as BigInt in WASM and as strings from the server. */
export const fmtN = (n: unknown) => {
  const v = typeof n === 'bigint' ? Number(n) : Number(n)
  return Number.isFinite(v) ? v.toLocaleString() : '0'
}

export function fmtAxis(ms: number, withClock: boolean, locale: string): string {
  const d = new Date(ms)
  return withClock
    ? d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}
