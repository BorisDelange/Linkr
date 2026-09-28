import { describe, it, expect } from 'vitest'
import type { ConceptSet } from '@/types'
import { planDictionarySync, readDictionaryTree, type IncomingConceptSet } from './content'
import { githubRepoOf, repoName } from './repo'

const setJson = (uid: string, version: string, name = 'Heart rate') => JSON.stringify({
  id: 1,
  name,
  expression: { items: [{ concept: { conceptId: 3027018 }, isExcluded: false, includeDescendants: true, includeMapped: false }] },
  metadata: { uniqueId: uid, version, translations: { en: { name, category: 'Vital signs' }, fr: { name: 'Fréquence cardiaque' } } },
})

describe('readDictionaryTree', () => {
  it('reads concept sets and units, and nothing else of the repo', () => {
    const content = readDictionaryTree({
      'concept_sets/10.json': setJson('b', '1.0.0'),
      'concept_sets/2.json': setJson('a', '1.0.0'),
      'concept_sets_resolved/2.json': '{}',
      'units/unit_conversions.json': '[{"conceptId":1,"sourceUnitConceptId":8636,"conversionFactor":5.55,"targetUnitConceptId":8753}]',
      'config.json': '{"title":"INDICATE Data Dictionary"}',
      'docs/app.js': 'x',
    }, 'abc')
    expect(content.conceptSets.map((s) => [s.sourceUrl, s.uniqueId, s.category])).toEqual([
      ['concept_sets/2.json', 'a', 'Vital signs'],
      ['concept_sets/10.json', 'b', 'Vital signs'],
    ])
    expect(content.unitConversions).toHaveLength(1)
    expect(content.recommendedUnits).toBeNull()
    expect(content).toMatchObject({ commit: 'abc', title: 'INDICATE Data Dictionary' })
  })
})

describe('planDictionarySync', () => {
  const incoming = (uid: string, version: string, name?: string): IncomingConceptSet =>
    readDictionaryTree({ [`concept_sets/${uid}.json`]: setJson(uid, version, name) }, null).conceptSets[0]
  const local = (id: string, from: IncomingConceptSet): ConceptSet => ({
    ...from, id, workspaceId: 'ws', dictionaryId: 'd', resolvedConceptIds: [1], createdAt: '', updatedAt: '',
  })

  it('adds, updates in place and removes, keyed on uniqueId', () => {
    const existing = [local('keep', incoming('a', '1.0.0')), local('same', incoming('b', '1.0.0')), local('gone', incoming('c', '1.0.0'))]
    const plan = planDictionarySync(existing, [incoming('a', '1.1.0', 'Heart rate v2'), incoming('b', '1.0.0'), incoming('d', '1.0.0')])
    expect(plan.added.map((s) => s.uniqueId)).toEqual(['d'])
    expect(plan.updated.map((u) => [u.id, u.fromVersion, u.incoming.version])).toEqual([['keep', '1.0.0', '1.1.0']])
    expect(plan.removed.map((s) => s.id)).toEqual(['gone'])
    expect(plan.unchanged).toBe(1)
  })

  // The server returns nulls where the client leaves fields out: not a change.
  it('reads a null as the absent field it stands for', () => {
    const next = incoming('a', '1.0.0')
    const fromServer = { ...local('x', next), sourceRepo: null, subcategory: null } as unknown as ConceptSet
    expect(planDictionarySync([fromServer], [next]).unchanged).toBe(1)
  })
})

describe('repository URLs', () => {
  it('reads a GitHub owner/repo from https and ssh forms', () => {
    expect(githubRepoOf('https://github.com/indicate-eu/data-dictionary')).toEqual({ owner: 'indicate-eu', repo: 'data-dictionary' })
    expect(githubRepoOf('git@github.com:indicate-eu/data-dictionary.git')).toEqual({ owner: 'indicate-eu', repo: 'data-dictionary' })
    expect(githubRepoOf('https://framagit.org/interhop/x')).toBeNull()
    expect(repoName('https://github.com/sfar/sfar-data-dictionary.git')).toBe('sfar-data-dictionary')
  })
})
