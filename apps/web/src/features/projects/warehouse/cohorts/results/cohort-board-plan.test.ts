import { describe, expect, it } from 'vitest'
import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import type { Cohort } from '@/types'
import { planCohortBoard } from './cohort-board-plan'

const mapping = mappingV1ToV2({
  presetId: 't', presetLabel: { en: 'T' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  noteTable: { table: 'note', idColumn: 'note_id', patientIdColumn: 'person_id', dateColumn: 'note_datetime', textColumn: 'note_text' },
} as SchemaMappingV1)
const t = (key: string) => key

const criterion = (id: string, type: string, config: object, exclude = false) =>
  ({ kind: 'criterion', id, type, enabled: true, operator: 'AND', exclude, config })
const cohort = (children: object[], customSql: string | null = null) =>
  ({ criteriaTree: { kind: 'group', id: 'r', operator: 'AND', exclude: false, enabled: true, children }, customSql }) as unknown as Cohort

describe('planCohortBoard', () => {
  it('gives the overview, the notes and a timeline over a data table per concept criterion, filling each tab', () => {
    const plan = planCohortBoard(cohort([
      criterion('c1', 'concept', { conceptIds: [1, 2], conceptNames: { 1: 'Heart rate', 2: 'Pulse' } }),
      criterion('c2', 'concept', { conceptIds: [3], conceptNames: { 3: 'Creatinine' } }),
      criterion('t1', 'text', { label: 'Sepsis', searches: [{ field: 'text', terms: ['sepsis', ' shock '] }] }),
    ]), mapping, t)
    expect(plan.map((p) => p.name)).toEqual(['cohorts.board_tab_overview', 'cohorts.board_tab_notes', 'Heart rate +1', 'Creatinine'])
    expect(plan.every((p) => p.widgets[0].size.w === 48)).toBe(true)
    expect(plan[2].widgets.map((w) => [w.pluginId, w.config, w.size.h])).toEqual([
      ['linkr-widget-timeline', { conceptIds: [1, 2], syncTimeRange: true }, 24],
      ['linkr-widget-datatable', { conceptIds: [1, 2], syncTimeRange: true }, 24],
    ])
    // The notes highlight the free-text terms, and show only the notes holding them.
    expect(plan[1].widgets[0].config).toEqual({
      wordSets: [{ id: 'criterion-t1', label: 'Sepsis', words: ['sepsis', 'shock'] }],
      appliedWordSetIds: ['criterion-t1'],
      filterToWordSets: true,
    })
  })

  it('leaves out what excludes from the cohort, and the criteria a hand-written query replaces', () => {
    const excluded = planCohortBoard(cohort([criterion('c1', 'concept', { conceptIds: [1], conceptNames: {} }, true)]), mapping, t)
    expect(excluded.map((p) => p.name)).toEqual(['cohorts.board_tab_overview', 'cohorts.board_tab_notes'])
    const custom = planCohortBoard(cohort([criterion('c1', 'concept', { conceptIds: [1], conceptNames: {} })], 'SELECT 1 AS patient_id'), mapping, t)
    expect(custom).toHaveLength(2)
  })

  it('has no notes tab without notes mapped', () => {
    const bare = mappingV1ToV2({ presetId: 't', presetLabel: { en: 'T' }, patientTable: { table: 'person', idColumn: 'person_id' } } as SchemaMappingV1)
    expect(planCohortBoard(cohort([]), bare, t).map((p) => p.name)).toEqual(['cohorts.board_tab_overview'])
  })
})
