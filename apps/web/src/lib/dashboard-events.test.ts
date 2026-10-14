import { describe, expect, it } from 'vitest'
import type { DashboardWidget } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import {
  DEFAULT_EVENT_COLOR, eventSelectionKeys, formatEventDate, isCompleteEvent, isValidEventColor, isValidEventDate,
  normalizeEvents, pruneEventIds, readDashboardEvents, selectEvents,
} from './dashboard-events'
import fixture from './event-date.fixture.json'

describe('isValidEventDate', () => {
  it('accepts and refuses the strings the format validator does', () => {
    for (const date of fixture.accepted) expect(isValidEventDate(date), date).toBe(true)
    for (const date of fixture.refused) expect(isValidEventDate(date), date).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(isValidEventDate(20250228)).toBe(false)
    expect(isValidEventDate(null)).toBe(false)
  })
})

describe('isValidEventColor', () => {
  it('takes a palette name or a six-digit hex, nothing else', () => {
    expect(isValidEventColor(DEFAULT_EVENT_COLOR)).toBe(true)
    expect(isValidEventColor('#0ea5e9')).toBe(true)
    expect(isValidEventColor('none')).toBe(false)
    expect(isValidEventColor('#abc')).toBe(false)
    expect(isValidEventColor('mauve')).toBe(false)
    expect(isValidEventColor(undefined)).toBe(false)
  })
})

describe('readDashboardEvents', () => {
  it('reads nothing from a dashboard without events', () => {
    expect(readDashboardEvents(undefined)).toEqual([])
    expect(readDashboardEvents(null)).toEqual([])
    expect(readDashboardEvents({})).toEqual([])
  })

  it('skips entries that cannot be drawn and keeps the first of a duplicated id', () => {
    const out = readDashboardEvents([
      { id: 'a', date: '2025-03-01', label: { en: 'A' }, color: 'red' },
      { id: 'a', date: '2025-04-01', label: { en: 'dup' }, color: 'red' },
      { id: '', date: '2025-03-01', label: { en: 'no id' } },
      { id: 'b', date: 'soon', label: { en: 'bad date' } },
      'junk',
    ])
    expect(out.map(e => e.label.en)).toEqual(['A'])
  })

  it('fills a missing colour, spreads a plain-string label, drops non-text languages', () => {
    const [plain, odd] = readDashboardEvents([
      { id: 'a', date: '2025-03-01', label: 'New protocol' },
      { id: 'b', date: '2025-04-01', label: { en: 'B', fr: 3 }, color: '' },
    ])
    expect(plain).toEqual({ id: 'a', date: '2025-03-01', label: { en: 'New protocol', fr: 'New protocol' }, color: DEFAULT_EVENT_COLOR })
    expect(odd.label).toEqual({ en: 'B' })
    expect(odd.color).toBe(DEFAULT_EVENT_COLOR)
  })

  it('sorts by date, then id', () => {
    const out = readDashboardEvents([
      { id: 'z', date: '2025-05-01', label: { en: 'late' } },
      { id: 'b', date: '2025-01-01', label: { en: 'early b' } },
      { id: 'a', date: '2025-01-01', label: { en: 'early a' } },
    ])
    expect(out.map(e => e.id)).toEqual(['a', 'b', 'z'])
  })
})

describe('normalizeEvents', () => {
  it('trims labels, drops blank languages and sorts', () => {
    const out = normalizeEvents([
      { id: 'b', date: '2025-06-01', label: { en: ' Later ', fr: '  ' }, color: 'red' },
      { id: 'a', date: '2025-01-01', label: { en: 'First' }, color: '' },
    ])
    expect(out).toEqual([
      { id: 'a', date: '2025-01-01', label: { en: 'First' }, color: DEFAULT_EVENT_COLOR },
      { id: 'b', date: '2025-06-01', label: { en: 'Later' }, color: 'red' },
    ])
  })
})

describe('isCompleteEvent', () => {
  it('needs a valid date and a label in at least one language', () => {
    expect(isCompleteEvent({ id: 'a', date: '2025-01-01', label: { fr: 'Début' }, color: 'red' })).toBe(true)
    expect(isCompleteEvent({ id: 'a', date: '2025-01-01', label: { en: ' ' }, color: 'red' })).toBe(false)
    expect(isCompleteEvent({ id: 'a', date: '', label: { en: 'x' }, color: 'red' })).toBe(false)
  })
})

describe('selectEvents', () => {
  const events = readDashboardEvents([
    { id: 'a', date: '2025-01-01', label: { en: 'A' } },
    { id: 'b', date: '2025-02-01', label: { en: 'B' } },
  ])

  it('keeps the selected events in time order and ignores deleted ids', () => {
    expect(selectEvents(events, ['b', 'gone', 'a']).map(e => e.id)).toEqual(['a', 'b'])
  })

  it('selects nothing from a missing or malformed selection', () => {
    expect(selectEvents(events, undefined)).toEqual([])
    expect(selectEvents(events, 'a')).toEqual([])
  })
})

describe('eventSelectionKeys', () => {
  it('reads the keys typed dashboard-events, and eventIds for an unknown plugin', () => {
    const schema: Record<string, PluginConfigField> = {
      dateColumn: { type: 'column-select', label: { en: 'Date', fr: 'Date' } },
      markers: { type: 'dashboard-events', label: { en: 'Events', fr: 'Événements' } },
    }
    expect(eventSelectionKeys(schema)).toEqual(['markers'])
    expect(eventSelectionKeys(undefined)).toEqual(['eventIds'])
  })
})

describe('pruneEventIds', () => {
  const widget = (id: string, source: DashboardWidget['source']): DashboardWidget => ({
    id, tabId: 't', name: { en: id }, layout: { x: 0, y: 0, w: 24, h: 12 }, source,
  })
  const schemaOf = (pluginId: string) => pluginId === 'spc'
    ? { markers: { type: 'dashboard-events', label: { en: 'Events', fr: 'Événements' } } satisfies PluginConfigField }
    : undefined

  it('returns only the widgets that selected a deleted event, with the survivors kept in order', () => {
    const out = pruneEventIds([
      widget('a', { type: 'plugin', pluginId: 'spc', config: { markers: ['e2', 'gone', 'e1'], eventIds: ['gone'] } }),
      widget('b', { type: 'plugin', pluginId: 'spc', config: { markers: ['e1'] } }),
      widget('c', { type: 'plugin', pluginId: 'other', config: { eventIds: ['gone', 'e1'] } }),
      widget('d', { type: 'inline', language: 'sql', code: 'select 1', config: { eventIds: ['gone'] } }),
    ], ['e1', 'e2'], schemaOf)
    expect(out.map((w) => [w.id, w.source.config])).toEqual([
      ['a', { markers: ['e2', 'e1'], eventIds: ['gone'] }],
      ['c', { eventIds: ['e1'] }],
    ])
  })

  it('leaves a missing or malformed selection alone', () => {
    expect(pruneEventIds([
      widget('a', { type: 'plugin', pluginId: 'spc', config: {} }),
      widget('b', { type: 'plugin', pluginId: 'spc', config: { markers: 'e1' } }),
    ], [], schemaOf)).toEqual([])
  })
})

describe('formatEventDate', () => {
  it('prints the stored day whatever the time zone, with the time when there is one', () => {
    expect(formatEventDate('2025-03-01', 'en')).toBe('Mar 1, 2025')
    expect(formatEventDate('2025-03-01T08:05', 'fr')).toBe('1 mars 2025 08:05')
  })

  it('returns an unreadable value as is', () => {
    expect(formatEventDate('soon', 'en')).toBe('soon')
  })
})
