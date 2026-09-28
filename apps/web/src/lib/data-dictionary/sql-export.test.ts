import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecommendedUnit, UnitConversion } from '@/types'
import { availableReferenceUnits, buildConceptSetSql, defaultReferenceUnit, type SqlConcept } from './sql-export'

// Golden files recorded from the INDICATE data dictionary's JavaScript export
// (tests/fixtures/sql/ of indicate-eu/data-dictionary, branch
// feat/core-extraction-mcp), with the inputs they were made from. The port must
// produce the same bytes.
const DIR = join(__dirname, '__fixtures__', 'sql-export')
const inputs = JSON.parse(readFileSync(join(DIR, 'inputs.json'), 'utf8')) as {
  manifest: {
    today: string
    origin: string
    pathname: string
    toolTag: string
    cases: { name: string; conceptSetId: number; refUnitId: number | null; dropOtherUnits: boolean; synthetic: boolean; why: string }[]
  }
  conceptSets: Record<string, { id: number; name?: string; version?: string; metadata: { translations: { en: { name?: string } } } }>
  resolvedConcepts: Record<string, SqlConcept[]>
  unitConversions: UnitConversion[]
  recommendedUnits: RecommendedUnit[]
}
const { manifest } = inputs

/** tests/js/cases.js: a second factor for the same source unit on another
 *  concept, which forces the nested CASE. */
function withSyntheticAmbiguity(conversions: UnitConversion[], concepts: SqlConcept[]): UnitConversion[] {
  const ids = concepts.filter((c) => c.standardConcept === 'S' && c.domainId === 'Measurement').map((c) => c.conceptId)
  const template = conversions.find((r) => ids.includes(r.conceptId) && r.targetUnitConceptId === 8753 && r.sourceUnitConceptId === 8840)!
  const other = ids.find((i) => i !== template.conceptId)!
  return [...conversions, { ...template, conceptId: other, conversionFactor: 0.5, offset: 0 }]
}

describe('buildConceptSetSql — byte-identical to the INDICATE export', () => {
  for (const c of manifest.cases) {
    it(`${c.name}: ${c.why}`, () => {
      const set = inputs.conceptSets[String(c.conceptSetId)]
      const concepts = inputs.resolvedConcepts[String(c.conceptSetId)]
      const conversions = c.synthetic ? withSyntheticAmbiguity(inputs.unitConversions, concepts) : inputs.unitConversions
      const permalink = `${manifest.origin}${manifest.pathname}#/concept-sets?id=${set.id}${set.version ? `&version=${set.version}` : ''}`
      const sql = buildConceptSetSql(
        {
          name: set.metadata.translations.en.name || set.name || 'Concept Set',
          id: set.id,
          version: set.version,
          permalink,
          toolTag: manifest.toolTag,
          today: manifest.today,
        },
        concepts,
        conversions,
        inputs.recommendedUnits,
        { referenceUnitId: c.refUnitId, dropOtherUnits: c.dropOtherUnits },
      )
      expect(sql).toBe(readFileSync(join(DIR, `${c.name}.sql`), 'utf8'))
    })
  }
})

describe('reference units', () => {
  it('offers the measurements\' recommended units and conversion targets', () => {
    const concepts = inputs.resolvedConcepts['155']
    const units = availableReferenceUnits(concepts, inputs.unitConversions, inputs.recommendedUnits)
    expect(units).toEqual([8753, 8840])
    expect(defaultReferenceUnit(concepts, inputs.recommendedUnits, units)).not.toBeNull()
  })

  it('offers none for a set with no measurement', () => {
    expect(availableReferenceUnits(inputs.resolvedConcepts['163'], inputs.unitConversions, inputs.recommendedUnits)).toEqual([])
  })
})
