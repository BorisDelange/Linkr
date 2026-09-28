import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecommendedUnit, UnitConversion } from '@/types'
import { availableReferenceUnits, buildConceptSetSql, defaultReferenceUnit, type SqlConcept } from './sql-export'
import { readDictionaryTree, sanitizeRecommendedUnits, sanitizeUnitConversions, UNIT_CONVERSIONS_FILE } from './content'

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

  it('keeps the same bytes once the unit rows went through the read-boundary gate', () => {
    const c = manifest.cases.find((x) => x.refUnitId !== null && !x.synthetic)!
    const set = inputs.conceptSets[String(c.conceptSetId)]
    const header = { name: 'x', id: set.id, permalink: 'p', toolTag: 't', today: manifest.today }
    const concepts = inputs.resolvedConcepts[String(c.conceptSetId)]
    const opts = { referenceUnitId: c.refUnitId, dropOtherUnits: c.dropOtherUnits }
    expect(sanitizeUnitConversions(inputs.unitConversions)).toHaveLength(inputs.unitConversions.length)
    expect(buildConceptSetSql(header, concepts, sanitizeUnitConversions(inputs.unitConversions)!, sanitizeRecommendedUnits(inputs.recommendedUnits)!, opts))
      .toBe(buildConceptSetSql(header, concepts, inputs.unitConversions, inputs.recommendedUnits, opts))
  })
})

describe('hostile dictionary content', () => {
  const concepts: SqlConcept[] = [
    { conceptId: 3004410, conceptName: 'HbA1c\nDROP TABLE person; --', domainId: 'Measurement', standardConcept: 'S' },
  ]
  const header = { name: 'Set\r\nDELETE FROM person', id: 1, permalink: 'https://x\nTRUNCATE death', toolTag: 't', today: '2026-01-01' }

  function nonCommentSql(sql: string): string {
    return sql.split('\n').map((line) => line.split('--')[0]).join('\n')
  }

  it('keeps line breaks in names inside their comment', () => {
    const sql = buildConceptSetSql(header, concepts, [], [], {})
    expect(nonCommentSql(sql)).not.toMatch(/DROP|DELETE|TRUNCATE/)
  })

  it('drops a conversion whose numbers are not numbers, at the read boundary and at the sink', () => {
    const hostile = [
      { conceptId: 3004410, sourceUnitConceptId: 8840, targetUnitConceptId: 8753, conversionFactor: '1; DROP TABLE measurement; --' },
      { conceptId: 3004410, sourceUnitConceptId: '8876) OR 1=1 --', targetUnitConceptId: 8753, conversionFactor: 2 },
      { conceptId: 3004410, sourceUnitConceptId: 8713, targetUnitConceptId: 8753, conversionFactor: '0.5', offset: 'x' },
      { conceptId: 3004410, sourceUnitConceptId: 9529, targetUnitConceptId: '8753', conversionFactor: '10' },
    ]
    const content = readDictionaryTree({ [UNIT_CONVERSIONS_FILE]: JSON.stringify(hostile) }, null)
    expect(content.unitConversions).toEqual([
      expect.objectContaining({ conceptId: 3004410, sourceUnitConceptId: 9529, targetUnitConceptId: 8753, conversionFactor: 10 }),
    ])
    const opts = { referenceUnitId: 8753 }
    for (const rows of [content.unitConversions!, hostile as unknown as UnitConversion[]]) {
      const sql = buildConceptSetSql(header, concepts, rows, [], opts)
      expect(nonCommentSql(sql)).not.toMatch(/DROP|DELETE|TRUNCATE|OR 1=1/)
    }
  })
})

describe('domain lookup', () => {
  it('does not read an inherited property as a CDM table', () => {
    const sql = buildConceptSetSql(
      { name: 'x', id: 1, permalink: 'p', toolTag: 't', today: '2026-01-01' },
      [{ conceptId: 1, conceptName: 'c', domainId: 'constructor', standardConcept: 'S' }], [], [],
    )
    expect(sql).toContain('-- No OMOP CDM table mapping for domain "constructor".')
  })
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
