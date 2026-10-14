import { cleanLocalized, toLocalized } from '@/lib/localized'
import { COLOR_MAP } from '@/lib/plugins/shared-styles'
import type { DashboardEvent, DashboardWidget, LocalizedString } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

/** Distinct from the SPC line (blue) and its signal colours (red, orange, teal). */
export const DEFAULT_EVENT_COLOR = 'violet'

/** The palette names an event may carry, besides a `#rrggbb` hex. */
export const EVENT_COLOR_NAMES = Object.keys(COLOR_MAP).filter((name) => name !== 'none')

export function isValidEventColor(value: unknown): value is string {
  return typeof value === 'string' && (EVENT_COLOR_NAMES.includes(value) || /^#[0-9a-fA-F]{6}$/.test(value))
}

const EVENT_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`, naming a day that exists. */
export function isValidEventDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = EVENT_DATE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return false
  return true
}

/** A date and a label in at least one language: what a marker needs to be drawn and named. */
export function isCompleteEvent(event: DashboardEvent): boolean {
  return isValidEventDate(event.date) && cleanLocalized(event.label) !== undefined
}

function compareEvents(a: DashboardEvent, b: DashboardEvent): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * A stored `events` value as the app can use it.
 *
 * Tolerant like every reader of an exported dashboard: a missing or malformed
 * value is no events, and an entry that cannot be drawn (no id, an impossible
 * date) is skipped rather than failing the dashboard. A plain-string label is
 * the label in every language; a missing colour takes the default. Sorted by
 * date, so the list and the export read in time order whatever order the
 * entries were written in.
 */
export function readDashboardEvents(raw: unknown): DashboardEvent[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: DashboardEvent[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { id, date, label, color } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !id || seen.has(id) || !isValidEventDate(date)) continue
    seen.add(id)
    out.push({
      id,
      date,
      label: readLabel(label),
      color: typeof color === 'string' && color ? color : DEFAULT_EVENT_COLOR,
    })
  }
  return out.sort(compareEvents)
}

function readLabel(label: unknown): LocalizedString {
  if (typeof label === 'string') return toLocalized(label)
  if (!label || typeof label !== 'object') return {}
  return Object.fromEntries(Object.entries(label).filter(([, text]) => typeof text === 'string'))
}

/** The events as they are stored: labels trimmed with their blank languages
 *  dropped, sorted by date. Incomplete entries are the caller's to refuse. */
export function normalizeEvents(events: readonly DashboardEvent[]): DashboardEvent[] {
  return events
    .map(e => ({ id: e.id, date: e.date, label: cleanLocalized(e.label) ?? {}, color: e.color || DEFAULT_EVENT_COLOR }))
    .sort(compareEvents)
}

/** The config keys holding a `dashboard-events` selection. An unknown plugin is read
 *  through the key every shipped plugin uses. */
export function eventSelectionKeys(schema: Record<string, PluginConfigField> | undefined): string[] {
  if (!schema) return ['eventIds']
  return Object.entries(schema).filter(([, field]) => field.type === 'dashboard-events').map(([key]) => key)
}

/**
 * The widgets still selecting an event the dashboard no longer has, each rewritten
 * to the surviving ids — the caller persists them. Nothing else about a widget
 * changes, and a widget whose selection is intact is not returned.
 */
export function pruneEventIds(
  widgets: readonly DashboardWidget[],
  survivingIds: readonly string[],
  schemaOf: (pluginId: string) => Record<string, PluginConfigField> | undefined,
): DashboardWidget[] {
  const alive = new Set(survivingIds)
  const out: DashboardWidget[] = []
  for (const widget of widgets) {
    if (widget.source.type !== 'plugin') continue
    const config = { ...widget.source.config }
    let changed = false
    for (const key of eventSelectionKeys(schemaOf(widget.source.pluginId))) {
      const selected = config[key]
      if (!Array.isArray(selected)) continue
      const kept = selected.filter((id) => typeof id === 'string' && alive.has(id))
      if (kept.length === selected.length) continue
      config[key] = kept
      changed = true
    }
    if (changed) out.push({ ...widget, source: { ...widget.source, config } })
  }
  return out
}

/** The dashboard's events a widget selected, in time order. Ids of deleted events are ignored. */
export function selectEvents(events: readonly DashboardEvent[], ids: unknown): DashboardEvent[] {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'))
  return events.filter(e => wanted.has(e.id))
}

/**
 * An event's date for display, in the app's language.
 *
 * Built from the stored digits rather than `new Date(value)`: a bare day parses
 * as UTC midnight and would print as the previous day west of Greenwich.
 */
export function formatEventDate(date: string, lang: string): string {
  const m = EVENT_DATE.exec(date)
  if (!m) return date
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const text = day.toLocaleDateString(lang.startsWith('fr') ? 'fr-FR' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  })
  return m[4] !== undefined ? `${text} ${m[4]}:${m[5]}` : text
}
