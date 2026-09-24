/**
 * Pure helpers behind freeze_cohort / unfreeze_cohort / import_atlas_cohort:
 * reading the ATLAS JSON a model sends, and wording the results. No I/O.
 */
import {
  importAtlasCohort, isAtlasCohortDefinition, type AtlasCohortDefinition,
} from '@/features/projects/warehouse/cohorts/atlas/atlas-converter'
import type { Cohort, CohortMaterialization, CriteriaGroupNode, CriteriaTreeNode } from '@/types'

export type AtlasInput = { definition: AtlasCohortDefinition; name?: string } | { error: string }

/**
 * The ATLAS cohort definition in whatever shape the model sent: the object, a
 * JSON string (possibly in a ```json fence), or a WebAPI cohort-definition
 * record whose `expression` holds the definition (itself maybe a string).
 */
export function readAtlasInput(raw: unknown): AtlasInput {
  const parsed = parseLoose(raw)
  if (parsed === undefined) return { error: 'atlas_json is a string that is not valid JSON.' }
  if (isObject(parsed) && !isAtlasCohortDefinition(parsed) && 'expression' in parsed) {
    const inner = parseLoose(parsed.expression)
    if (isAtlasCohortDefinition(inner)) {
      return { definition: inner, ...(typeof parsed.name === 'string' && parsed.name ? { name: parsed.name } : {}) }
    }
  }
  if (!isAtlasCohortDefinition(parsed)) {
    return { error: 'atlas_json is not an ATLAS cohort definition: expected an object with ConceptSets and PrimaryCriteria.' }
  }
  return { definition: parsed }
}

function parseLoose(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const body = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The app's conversion (the Import ATLAS dialog's), plus how many criteria it kept. */
export function convertAtlas(definition: AtlasCohortDefinition) {
  const { criteriaTree, warnings } = importAtlasCohort(definition)
  return { tree: criteriaTree, warnings, criteria: countCriteria(criteriaTree) }
}

export function countCriteria(node: CriteriaGroupNode): number {
  return node.children.reduce((n, c: CriteriaTreeNode) => n + (c.kind === 'criterion' ? 1 : countCriteria(c)), 0)
}

/** Why a cohort cannot be frozen, in the app's terms, or null. */
export function freezeBlocker(cohort: Pick<Cohort, 'projectUid' | 'level'>): string | null {
  if (!cohort.projectUid) {
    return 'Only a project\'s cohort can be frozen: a database cohort has no frozen membership (its derivations recompute it).'
  }
  if (cohort.level === 'event') return 'An event-level cohort cannot be frozen: its rows span several tables, with no single id.'
  return null
}

/** What freezing did, for the model. */
export function describeFreeze(
  name: string, mat: CohortMaterialization, previous: CohortMaterialization | null | undefined, customSql: boolean,
): string {
  const lines = [
    `Froze "${name}": ${mat.count} ${mat.level}(s)`
    + `${mat.level === 'patient' ? '' : ` of ${mat.patientIds.length} patient(s)`}, at ${mat.materializedAt}.`,
    'Patient data now reads this frozen list; it no longer follows data changes until frozen again or unfrozen.',
  ]
  if (previous) lines.push(`It replaces the snapshot of ${previous.materializedAt} (${previous.count}).`)
  if (customSql) {
    lines.push('Note: this cohort has custom SQL, which only gives a count — as in the app, the membership was frozen from its criteria.')
  }
  return lines.join('\n')
}
