/**
 * A quality profile's checks: which ones it takes from each rule set, and the
 * list it runs.
 *
 * A profile points at checks by (rule set, `checkKey`) and never copies them.
 * In `all` mode it takes the whole rule set, so a check added later joins on its
 * own; in `selected` mode only the keys listed. Disabled checks are left out of
 * every run, as they are from the rule set's own.
 */
import { runnableChecks, type DqCheck } from '@/lib/duckdb/data-quality-checks'
import type { DqCustomCheck, DqProfileSource, DqRuleSet, EntityRef } from '@/types'

/** A rule set as a profile points at it: its local row and its portable identity. */
export interface ProfileRuleSet {
  ruleSet: DqRuleSet
  ref: EntityRef
}

export function profileRuleSet(ruleSet: DqRuleSet): ProfileRuleSet {
  return {
    ruleSet,
    ref: {
      ...(ruleSet.lineageId ? { lineageId: ruleSet.lineageId } : {}),
      ...(ruleSet.entityId ? { entityId: ruleSet.entityId } : {}),
      label: ruleSet.name,
    },
  }
}

/** Whether the profile takes this check of the source's rule set. */
export function takesCheck(source: DqProfileSource | undefined, checkKey: string): boolean {
  if (!source) return false
  return source.mode === 'all' || (source.checkKeys ?? []).includes(checkKey)
}

/** The checks of one rule set the profile takes, in the rule set's order. */
export function takenChecks(source: DqProfileSource | undefined, checks: DqCustomCheck[]): DqCustomCheck[] {
  return checks.filter((c) => takesCheck(source, c.checkKey))
}

export interface ProfileGaps {
  /** Sources whose rule set is gone from the workspace. */
  missingRuleSets: string[]
  /** `selected` keys no check of their rule set holds any more, per rule set id. */
  missingChecks: Record<string, string[]>
}

/** What the profile points at and can no longer find. */
export function profileGaps(
  sources: DqProfileSource[],
  ruleSets: Pick<DqRuleSet, 'id'>[],
  checksByRuleSet: Record<string, DqCustomCheck[] | undefined>,
): ProfileGaps {
  const known = new Set(ruleSets.map((rs) => rs.id))
  const gaps: ProfileGaps = { missingRuleSets: [], missingChecks: {} }
  for (const source of sources) {
    if (!known.has(source.ruleSetId)) {
      gaps.missingRuleSets.push(source.ruleSetId)
      continue
    }
    const checks = checksByRuleSet[source.ruleSetId]
    if (!checks || source.mode !== 'selected') continue
    const have = new Set(checks.map((c) => c.checkKey))
    const gone = (source.checkKeys ?? []).filter((k) => !have.has(k))
    if (gone.length) gaps.missingChecks[source.ruleSetId] = gone
  }
  return gaps
}

/**
 * The checks a run of the profile executes: rule set by rule set in the
 * profile's order, enabled checks only, each stamped with where it comes from —
 * the run's report keeps that, so a past run still says which rule set (and
 * which version of it) each result belongs to.
 */
export function profileRunChecks(
  sources: DqProfileSource[],
  ruleSets: DqRuleSet[],
  checksByRuleSet: Record<string, DqCustomCheck[] | undefined>,
  ruleSetName: (ruleSet: DqRuleSet) => string,
): DqCheck[] {
  const byId = new Map(ruleSets.map((rs) => [rs.id, rs]))
  return sources.flatMap((source) => {
    const ruleSet = byId.get(source.ruleSetId)
    const checks = checksByRuleSet[source.ruleSetId]
    if (!ruleSet || !checks) return []
    const keyOf = new Map(checks.map((c) => [c.id, c.checkKey]))
    return runnableChecks(takenChecks(source, checks)).map((check) => ({
      ...check,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSetName(ruleSet),
      ruleSetVersion: ruleSet.version ?? '0.1.0',
      checkKey: keyOf.get(check.id),
    }))
  })
}

/** The sources with one rule set's entry replaced (`null` removes it), others untouched. */
function withSource(sources: DqProfileSource[], ruleSetId: string, next: DqProfileSource | null): DqProfileSource[] {
  const at = sources.findIndex((s) => s.ruleSetId === ruleSetId)
  if (at < 0) return next ? [...sources, next] : sources
  return next ? sources.map((s, i) => (i === at ? next : s)) : sources.filter((_, i) => i !== at)
}

/** Take the whole rule set (new checks join on their own), or drop it. */
export function setWholeRuleSet(
  sources: DqProfileSource[],
  ruleSet: Pick<DqRuleSet, 'id'> & { ref?: DqProfileSource['ruleSetRef'] },
  on: boolean,
): DqProfileSource[] {
  return withSource(sources, ruleSet.id, on ? {
    ruleSetId: ruleSet.id,
    ...(ruleSet.ref ? { ruleSetRef: ruleSet.ref } : {}),
    mode: 'all',
  } : null)
}

/**
 * Take or leave some checks of a rule set. Leaving one out of a whole rule set
 * turns it into a selection of all its other checks; leaving the last one out
 * drops the rule set from the profile.
 */
export function setChecks(
  sources: DqProfileSource[],
  ruleSet: Pick<DqRuleSet, 'id'> & { ref?: DqProfileSource['ruleSetRef'] },
  allKeys: string[],
  keys: string[],
  on: boolean,
): DqProfileSource[] {
  const current = sources.find((s) => s.ruleSetId === ruleSet.id)
  if (on && current?.mode === 'all') return sources
  const taken = new Set(current?.mode === 'all' ? allKeys : current?.checkKeys ?? [])
  for (const k of keys) {
    if (on) taken.add(k)
    else taken.delete(k)
  }
  if (taken.size === 0) return withSource(sources, ruleSet.id, null)
  return withSource(sources, ruleSet.id, {
    ruleSetId: ruleSet.id,
    ...(current?.ruleSetRef ?? ruleSet.ref ? { ruleSetRef: current?.ruleSetRef ?? ruleSet.ref } : {}),
    mode: 'selected',
    // In the rule set's order, so the stored list does not churn with clicks.
    checkKeys: allKeys.filter((k) => taken.has(k)).concat([...taken].filter((k) => !allKeys.includes(k))),
  })
}
