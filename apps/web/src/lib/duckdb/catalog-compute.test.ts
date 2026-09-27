import { mappingV1ToV2, type SchemaMappingV1 } from '@/lib/schema-classes/v1'
import { describe, expect, it } from 'vitest'
import type { CatalogCrossingResult, DataCatalog } from '@/types'
import { defaultCatalogVariables } from '@/lib/data-catalog/config'
import { orderModalities, planCrossings } from './catalog-compute'

const mapping = mappingV1ToV2({
  patientTable: { table: 'person', idColumn: 'person_id', birthYearColumn: 'year_of_birth', genderColumn: 'gender' },
  visitTable: { table: 'visit', idColumn: 'visit_id', patientIdColumn: 'person_id', startDateColumn: 'start', typeColumn: 'type' },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: { M: { table: 'measurement', conceptIdColumn: 'cid', patientIdColumn: 'person_id', dateColumn: 'd' } },
  genderValues: { male: 'M', female: 'F' },
} as unknown as SchemaMappingV1)

function catalog(patch: Partial<DataCatalog> = {}): DataCatalog {
  return {
    id: 'c', dataSourceId: 'd', variables: defaultCatalogVariables(), crossings: [],
    anonymization: { threshold: 10, mode: 'replace' }, ...patch,
  } as DataCatalog
}

describe('planCrossings', () => {
  it('plans the 1-way marginals first, then the chosen crossings', async () => {
    const plan = await planCrossings(catalog({ crossings: [['age', 'period']] }), mapping, async () => [])
    expect(plan.units.map((u) => u.crossingId)).toEqual(['period', 'age', 'sex', 'period-age'])
  })

  it('splits a concept crossing into chunks and reuses the ranking for the concept marginal', async () => {
    const ranked = Array.from({ length: 4500 }, (_, i) => ({ concept: String(i), patients: 4500 - i, records: 1 }))
    const variables = { ...defaultCatalogVariables(), concept: { enabled: true, level: 'concept' as const, scope: 'all' as const, topN: 10 } }
    const plan = await planCrossings(catalog({ variables, crossings: [['concept', 'sex']] }), mapping, async (sql) => (sql.includes('GROUP BY concept') ? ranked : []))
    const concept = plan.units.find((u) => u.crossingId === 'concept')!
    expect(concept.precomputed).toHaveLength(4500)
    const chunks = plan.units.filter((u) => u.crossingId === 'concept-sex')
    expect(chunks.map((u) => u.label)).toEqual(['concept-sex (1/3)', 'concept-sex (2/3)', 'concept-sex (3/3)'])
    expect(chunks[2].conceptFilter).toEqual([{ dictKey: 'concept', ids: ranked.slice(4000).map((r) => r.concept) }])
  })

  it('keeps the N largest services of a top-N grouping', async () => {
    const variables = { ...defaultCatalogVariables(), service: { enabled: true, level: 'visit' as const, grouping: 'top' as const, topN: 2, groups: {}, unassigned: 'other' as const } }
    const plan = await planCrossings(catalog({ variables }), mapping, async (sql) => (sql.includes('AS svc') ? [{ svc: 'A' }, { svc: 'B' }, { svc: 'C' }] : []))
    expect(plan.ctx.topServices).toEqual(['A', 'B'])
  })
})

describe('orderModalities', () => {
  it('orders periods with their gaps, services by patients with Other last', () => {
    const variables = { ...defaultCatalogVariables(), service: { enabled: true, level: 'visit' as const, grouping: 'top' as const, topN: 1, groups: {}, unassigned: 'other' as const } }
    const crossings: CatalogCrossingResult[] = [
      { id: 'period', variables: ['period'], rows: [{ values: ['2024'], patients: 5 }, { values: ['2021'], patients: 5 }] },
      { id: 'service', variables: ['service'], rows: [{ values: ['__other__'], patients: 99 }, { values: ['ICU'], patients: 20 }] },
      { id: 'sex', variables: ['sex'], rows: [{ values: ['male'], patients: 5 }] },
    ]
    const out = orderModalities({ variables }, crossings)
    expect(out.period).toEqual(['2021', '2022', '2023', '2024'])
    expect(out.service).toEqual(['ICU', '__other__'])
    expect(out.sex).toEqual(['male', 'female'])
    expect(out.age?.[0]).toBe('[0;10[')
  })
})
