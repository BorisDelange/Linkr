/**
 * A cohort's criteria in words, for the report's "criteria applied" section.
 *
 * The builder's own labels (`getNodeLabel`) are chips — "Age >= 18" — and English
 * only. A report is read by someone who never saw the builder, so each criterion
 * is spelled out in the report's language, with the unit, the reference date and
 * the codes it rests on.
 */
import type { TFunction } from 'i18next'
import type {
  AgeCriteriaConfig,
  CareSiteCriteriaConfig,
  ConceptCriteriaConfig,
  CriteriaGroupNode,
  CriteriaTreeNode,
  DeathCriteriaConfig,
  DurationCriteriaConfig,
  PeriodCriteriaConfig,
  SchemaMapping,
  SexCriteriaConfig,
  TextCriteriaConfig,
} from '@/types'

export interface DescribedCriterion {
  /** Nesting depth under the root group, 0 for a top-level criterion. */
  depth: number
  /** How it joins the previous sibling; absent on the first of its group. */
  operator?: 'AND' | 'OR'
  text: string
}

const K = 'cohort_report.crit_'

function range(t: TFunction, min: number | undefined, max: number | undefined, unit: string): string {
  if (min != null && max != null) return t(`${K}range_between`, { min, max, unit })
  if (min != null) return t(`${K}range_min`, { min, unit })
  if (max != null) return t(`${K}range_max`, { max, unit })
  return t(`${K}range_any`)
}

export function describeCriterion(node: CriteriaTreeNode, t: TFunction, mapping?: SchemaMapping): string {
  if (node.kind === 'group') {
    return node.label || t(`${K}group`)
  }
  const text = describeLeaf(node.type, node.config, t, mapping)
  return node.exclude ? t(`${K}not`, { text }) : text
}

function describeLeaf(
  type: string,
  config: unknown,
  t: TFunction,
  mapping?: SchemaMapping,
): string {
  switch (type) {
    case 'age': {
      const c = config as AgeCriteriaConfig
      const unit = t(`${K}unit_${c.ageUnit ?? 'years'}`)
      return t(c.ageReference === 'admission' ? `${K}age_admission` : `${K}age_current`, {
        range: range(t, c.min, c.max, unit),
      })
    }
    case 'sex': {
      const c = config as SexCriteriaConfig
      const gv = mapping?.genderValues
      const name = (v: string) =>
        v === gv?.male ? t(`${K}sex_male`) : v === gv?.female ? t(`${K}sex_female`) : v === gv?.unknown ? t(`${K}sex_unknown`) : v
      return t(`${K}sex`, { values: c.values.map(name).join(', ') })
    }
    case 'death': {
      const c = config as DeathCriteriaConfig
      const when = t(`${K}death_${c.deathReference ?? 'any'}`)
      return t(c.isDead ? `${K}deceased` : `${K}alive`, { when })
    }
    case 'period': {
      const c = config as PeriodCriteriaConfig
      if (c.startDate && c.endDate) return t(`${K}period_between`, { start: c.startDate, end: c.endDate })
      if (c.startDate) return t(`${K}period_from`, { start: c.startDate })
      if (c.endDate) return t(`${K}period_until`, { end: c.endDate })
      return t(`${K}period_any`)
    }
    case 'duration': {
      const c = config as DurationCriteriaConfig
      const unit = t(`${K}unit_${c.durationUnit ?? 'days'}`)
      return t(`${K}duration`, {
        level: t(`${K}level_${c.durationLevel}`),
        range: range(t, c.minDays, c.maxDays, unit),
      })
    }
    case 'care_site': {
      const c = config as CareSiteCriteriaConfig
      return t(`${K}care_site`, { level: t(`${K}level_${c.careSiteLevel}`), values: c.values.join(', ') })
    }
    case 'concept': {
      const c = config as ConceptCriteriaConfig
      const concepts = c.conceptIds
        .map((id) => (c.conceptNames?.[id] ? `${c.conceptNames[id]} (${id})` : String(id)))
        .join(', ')
      const parts = [t(`${K}concept`, { table: c.eventTableLabel, concepts })]
      for (const f of c.valueFilters ?? []) {
        parts.push(f.operator === 'between'
          ? t(`${K}value_between`, { min: f.value, max: f.value2 })
          : t(`${K}value`, { op: f.operator, value: f.value }))
      }
      if (c.occurrenceCount) {
        parts.push(t(`${K}occurrences`, { op: c.occurrenceCount.operator, count: c.occurrenceCount.count }))
      }
      return parts.join(', ')
    }
    case 'text': {
      const c = config as TextCriteriaConfig
      const terms = (c.searches ?? []).flatMap((s) => s.terms).filter(Boolean)
      return t(`${K}text`, { terms: c.label || terms.join(', ') || c.description || '—' })
    }
    default:
      return type
  }
}

/** Every enabled criterion of the tree, depth-first, in the order the builder shows them. */
export function describeCriteria(
  tree: CriteriaGroupNode,
  t: TFunction,
  mapping?: SchemaMapping,
): DescribedCriterion[] {
  const out: DescribedCriterion[] = []
  const walk = (group: CriteriaGroupNode, depth: number) => {
    const children = group.children.filter((c) => c.enabled)
    children.forEach((child, i) => {
      out.push({
        depth,
        ...(i > 0 ? { operator: child.operator } : {}),
        text: describeCriterion(child, t, mapping),
      })
      if (child.kind === 'group') walk(child, depth + 1)
    })
  }
  walk(tree, 0)
  return out
}
