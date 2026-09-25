import { describe, expect, it } from 'vitest'
import { buildOverviewInventoryQuery } from '@/lib/duckdb/patient-overview-queries'
import { buildTimelineQuery } from '@/lib/duckdb/patient-data-queries'
import { eavMapping, omopMapping, siteOverrides } from './__fixtures__/drug-acceptance'
import { effectiveMapping } from './overrides'
import { dictionaryOf, drugRelation, eventRelation } from './relations'

// Plan step 10. The rows these relations return were also checked end to end on
// DuckDB against synthetic tables, EAV and OMOP giving the same contract rows.

describe('drug administrations from an EAV warehouse and from OMOP', () => {
  const eav = drugRelation(eavMapping, 'Administrations')!
  const omop = drugRelation(omopMapping, 'Drug exposures')!

  it('pivots the EAV attributes by their codes, given as parameters', () => {
    expect(eav.problems).toEqual([])
    expect(eav.sql).toContain(`WHERE d.attribute = 'DRUG'`)
    expect(eav.sql).toContain(`f.attribute = 'RATE' THEN f.num_value`)
    expect([...eav.mapped].sort()).toEqual([
      'amount_unit', 'amount_value', 'concept_id', 'drug_kind', 'patient_id', 'rate_value', 'route', 'start_datetime',
      'unit', 'value_number', 'visit_id',
    ])
  })

  it('lets a site override the codes without touching the relation', () => {
    const site = drugRelation(effectiveMapping(eavMapping, siteOverrides), 'Administrations')!
    expect(site.sql).toContain(`f.attribute = 'RATE_ML_H' THEN f.num_value`)
    expect(site.sql).not.toContain(`'RATE' THEN`)
    expect(site.sql).toContain(`WHERE d.attribute = 'DRUG'`)
  })

  it('reads the OMOP twin visually, with the same derived event columns', () => {
    expect(omop.problems).toEqual([])
    expect(omop.custom).toBe(false)
    expect(omop.sql).toContain('de."quantity" AS value_number')
    expect(omop.sql).toContain(`'administration' AS drug_kind`)
    for (const col of ['patient_id', 'concept_id', 'start_datetime', 'drug_kind', 'value_number', 'route']) {
      expect(eav.mapped.has(col) && omop.mapped.has(col)).toBe(true)
    }
  })

  it('reaches both through the same consumers as any event relation', () => {
    for (const [mapping, label] of [[eavMapping, 'Administrations'], [omopMapping, 'Drug exposures']] as const) {
      const rel = eventRelation(mapping, label)!
      expect(rel.cls).toBe('drug')
      expect(dictionaryOf(mapping, rel)?.cls).toBe('concept')
      expect(buildOverviewInventoryQuery(mapping, '1', null)).toContain('TRUE AS is_drug')
      expect(buildTimelineQuery(mapping, [1], '1', null)).toContain(`FROM ${rel.name} e`)
    }
  })
})
