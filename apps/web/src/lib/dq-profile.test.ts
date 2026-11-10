import { describe, expect, it } from 'vitest'
import type { DqCustomCheck, DqProfileSource, DqRuleSet } from '@/types'
import { profileGaps, profileRunChecks, setChecks, setWholeRuleSet, takenChecks } from './dq-profile'

const check = (ruleSetId: string, checkKey: string, order: number, disabled = false) =>
  ({
    id: `${ruleSetId}:${checkKey}`, ruleSetId, checkKey, name: { en: checkKey }, description: {}, category: 'plausibility',
    subcategory: null, severity: 'warning', threshold: 0, sql: 'SELECT 1', exploreSql: null, order,
    origin: 'manual', templateKey: null, groupKey: null, disabled, createdAt: '', updatedAt: '',
  }) as DqCustomCheck

const ruleSet = (id: string, version = '1.0.0') => ({ id, version, name: { en: id } }) as unknown as DqRuleSet

const CHECKS = {
  a: [check('a', 'a1', 0), check('a', 'a2', 1), check('a', 'a3', 2, true)],
  b: [check('b', 'b1', 0), check('b', 'b2', 1)],
}

describe('dq-profile', () => {
  it('takes a whole rule set, or only the keys selected', () => {
    expect(takenChecks({ ruleSetId: 'a', mode: 'all' }, CHECKS.a).map((c) => c.checkKey)).toEqual(['a1', 'a2', 'a3'])
    expect(takenChecks({ ruleSetId: 'a', mode: 'selected', checkKeys: ['a2'] }, CHECKS.a).map((c) => c.checkKey)).toEqual(['a2'])
    expect(takenChecks(undefined, CHECKS.a)).toEqual([])
  })

  it('runs the enabled checks, rule set by rule set, each stamped with its origin', () => {
    const sources: DqProfileSource[] = [{ ruleSetId: 'b', mode: 'selected', checkKeys: ['b2'] }, { ruleSetId: 'a', mode: 'all' }]
    const run = profileRunChecks(sources, [ruleSet('a'), ruleSet('b', '2.0.0')], CHECKS, (rs) => rs.id.toUpperCase())
    expect(run.map((c) => c.checkKey)).toEqual(['b2', 'a1', 'a2'])
    expect(run[0]).toMatchObject({ ruleSetId: 'b', ruleSetName: 'B', ruleSetVersion: '2.0.0', checkKey: 'b2' })
  })

  it('says what it points at and can no longer find', () => {
    const sources: DqProfileSource[] = [
      { ruleSetId: 'a', mode: 'selected', checkKeys: ['a1', 'gone'] },
      { ruleSetId: 'deleted', mode: 'all' },
    ]
    expect(profileGaps(sources, [ruleSet('a')], CHECKS)).toEqual({ missingRuleSets: ['deleted'], missingChecks: { a: ['gone'] } })
  })

  it('turns a whole rule set into a selection when one check is left out, and drops it when none is left', () => {
    const keys = CHECKS.b.map((c) => c.checkKey)
    let sources = setWholeRuleSet([], { id: 'b' }, true)
    expect(sources).toEqual([{ ruleSetId: 'b', mode: 'all' }])
    expect(setChecks(sources, { id: 'b' }, keys, ['b1'], true)).toBe(sources)
    sources = setChecks(sources, { id: 'b' }, keys, ['b1'], false)
    expect(sources).toEqual([{ ruleSetId: 'b', mode: 'selected', checkKeys: ['b2'] }])
    sources = setChecks(sources, { id: 'b' }, keys, ['b1'], true)
    expect(sources[0].checkKeys).toEqual(['b1', 'b2'])
    expect(setChecks(sources, { id: 'b' }, keys, ['b1', 'b2'], false)).toEqual([])
    expect(setWholeRuleSet([{ ruleSetId: 'b', mode: 'all' }], { id: 'b' }, false)).toEqual([])
  })
})
