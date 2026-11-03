/**
 * The tabs a cohort's patient board is generated with, from its criteria: the
 * patient's record at a glance, the notes highlighting what the free-text
 * criteria search for, and a timeline of each concept criterion's concepts.
 */
import { DASHBOARD_GRID } from '@/features/projects/dashboard/dashboard-grid'
import { classRelation, has } from '@/lib/schema-classes/relations'
import {
  NOTES_PLUGIN_ID,
  PATIENT_OVERVIEW_PLUGIN_ID,
  TIMELINE_PLUGIN_ID,
} from '@/lib/plugins/builtin-widget-plugins'
import type { Cohort, ConceptCriteriaConfig, CriteriaTreeNode, SchemaMapping, TextCriteriaConfig } from '@/types'

export interface PlannedWidget {
  pluginId: string
  name: string
  config: Record<string, unknown>
  size: { w: number; h: number }
}

export interface PlannedTab {
  name: string
  widgets: PlannedWidget[]
}

/** The whole tab: the full width, and as tall as a board fitted to its height shows. */
const FULL = { w: DASHBOARD_GRID.cols, h: 30 }
/** Longest tab name, past which it ends in an ellipsis. */
const NAME_LENGTH = 40

type Label = (key: string) => string

/** The enabled criteria of the tree that include (an excluded one names who is NOT in the cohort). */
function included(node: CriteriaTreeNode): CriteriaTreeNode[] {
  if (!node.enabled || node.exclude) return []
  return node.kind === 'group' ? node.children.flatMap(included) : [node]
}

const shortened = (name: string) => (name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1).trimEnd()}…` : name)

/** A concept criterion's name: its concepts, as many as the tab name holds. */
function conceptTabName(config: ConceptCriteriaConfig): string {
  const names = config.conceptIds.map((id) => config.conceptNames?.[id] ?? String(id))
  return shortened(names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? ''))
}

export function planCohortBoard(cohort: Pick<Cohort, 'criteriaTree' | 'customSql'>, mapping: SchemaMapping | undefined, t: Label): PlannedTab[] {
  // A hand-written query replaces the criteria: there is nothing to plan from them.
  const criteria = cohort.customSql?.trim() ? [] : included(cohort.criteriaTree)
  const tabs: PlannedTab[] = [{
    name: t('cohorts.board_tab_overview'),
    widgets: [{ pluginId: PATIENT_OVERVIEW_PLUGIN_ID, name: t('cohorts.board_tab_overview'), config: {}, size: FULL }],
  }]

  if (has(mapping ? classRelation(mapping, 'note') : undefined, 'text')) {
    // Each free-text criterion's terms, highlighted and kept as the notes shown.
    const wordSets = criteria.flatMap((c) => {
      if (c.kind !== 'criterion' || c.type !== 'text') return []
      const config = c.config as TextCriteriaConfig
      const words = [...new Set((config.searches ?? []).filter((s) => !s.exclude).flatMap((s) => s.terms.map((w) => w.trim())).filter(Boolean))]
      return words.length ? [{ id: `criterion-${c.id}`, label: config.label?.trim() || words.join(', '), words }] : []
    })
    tabs.push({
      name: t('cohorts.board_tab_notes'),
      widgets: [{
        pluginId: NOTES_PLUGIN_ID,
        name: t('cohorts.board_tab_notes'),
        config: wordSets.length
          ? { wordSets, appliedWordSetIds: wordSets.map((s) => s.id), filterToWordSets: true }
          : {},
        size: FULL,
      }],
    })
  }

  for (const c of criteria) {
    if (c.kind !== 'criterion' || c.type !== 'concept') continue
    const config = c.config as ConceptCriteriaConfig
    if (!config.conceptIds?.length) continue
    const name = conceptTabName(config)
    tabs.push({
      name,
      widgets: [{ pluginId: TIMELINE_PLUGIN_ID, name, config: { conceptIds: [...config.conceptIds] }, size: FULL }],
    })
  }
  return tabs
}
