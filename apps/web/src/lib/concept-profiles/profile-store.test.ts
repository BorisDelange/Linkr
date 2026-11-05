import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_OPTIONS, type ProfileOptions } from '@/lib/concept-mapping/concept-profile'
import {
  exactOptions,
  filterProfile,
  mergeProfile,
  missingSections,
  sectionSet,
  variantOf,
  type StoredProfile,
} from './profile-store'

const variant = variantOf(DEFAULT_PROFILE_OPTIONS)
const id = { dictKey: 'omop', conceptId: 7 }

const stored = (over: Partial<StoredProfile> = {}): StoredProfile => ({
  ...id,
  rowsCount: 500,
  patientsCount: 40,
  json: {
    full_name: 'Glucose',
    numeric_data: { min: 1, max: 9 },
    histogram: [{ x: 1, count: 3 }],
    categorical_data: [
      { category: 'high', count: 300, patients_count: 30, percentage: 60 },
      { category: 'low', count: 150, patients_count: 20, percentage: 30 },
      { category: 'a very long comment typed into the value', count: 50, patients_count: 2, percentage: 10 },
    ],
    hospital_units: [{ unit: 'ICU', percentage: 80 }, { unit: 'ED', percentage: 20 }],
  },
  sections: ['counts', 'numeric', 'histogram', 'categorical', 'hospitalUnits'],
  variant,
  fingerprint: 'f1',
  computedAt: '2026-11-02T00:00:00Z',
  ...over,
})

const options = (over: Partial<ProfileOptions> = {}): ProfileOptions => ({ ...DEFAULT_PROFILE_OPTIONS, ...over })

describe('exactOptions', () => {
  it('keeps the sections and the variant, drops every threshold', () => {
    const exact = exactOptions(options({ minPatients: 11, minCategoryCount: 50, topN: 10 }))
    expect(exact).toMatchObject({ minPatients: 0, minCategoryCount: 1, outlierMethod: 'iqr' })
    expect(exact.topN).toBeGreaterThan(10)
  })
})

describe('missingSections', () => {
  const wanted = sectionSet(['counts', 'numeric', 'unit'])

  it('asks for what the store lacks only', () => {
    expect(missingSections(stored(), wanted, variant, 'f1')).toEqual(['unit'])
  })

  it('asks for everything without a profile, or on other data', () => {
    expect(missingSections(undefined, wanted, variant, 'f1')).toEqual(['counts', 'numeric', 'unit'])
    expect(missingSections(stored(), wanted, variant, 'f2')).toEqual(['counts', 'numeric', 'unit'])
  })

  it('recomputes the numeric sections under another variant', () => {
    expect(missingSections(stored(), wanted, { ...variant, outlierMethod: 'mad' }, 'f1')).toEqual(['numeric', 'unit'])
  })
})

describe('mergeProfile', () => {
  it('adds the fresh sections and keeps the others', () => {
    const merged = mergeProfile(stored(), { json: { full_name: 'Glucose', unit: 'mg/dL' }, rowsCount: 510, patientsCount: 41 }, ['unit'], id, variant, 'f1', 'now')
    expect(merged.json.unit).toBe('mg/dL')
    expect(merged.json.numeric_data).toEqual({ min: 1, max: 9 })
    expect(merged.sections).toEqual(expect.arrayContaining(['numeric', 'unit']))
    expect(merged).toMatchObject({ rowsCount: 510, patientsCount: 41, computedAt: 'now' })
  })

  it('replaces a recomputed section, even when it came back empty', () => {
    const merged = mergeProfile(stored(), { json: {}, rowsCount: 1, patientsCount: 1 }, ['categorical'], id, variant, 'f1', 'now')
    expect(merged.json.categorical_data).toBeUndefined()
    expect(merged.sections).toContain('categorical')
  })

  it('keeps nothing computed on other data', () => {
    const merged = mergeProfile(stored(), { json: { unit: 'mg' }, rowsCount: 1, patientsCount: 1 }, ['counts', 'unit'], id, variant, 'f2', 'now')
    expect(merged.json).toEqual({ unit: 'mg' })
    expect(merged.sections).toEqual(['counts', 'unit'])
  })

  it('drops numeric sections of another variant rather than mislabel them', () => {
    const merged = mergeProfile(stored(), { json: {}, rowsCount: 1, patientsCount: 1 }, ['unit'], id, { ...variant, bins: 10 }, 'f1', 'now')
    expect(merged.json.numeric_data).toBeUndefined()
    expect(merged.sections).not.toContain('numeric')
  })
})

describe('filterProfile', () => {
  it('withholds the profile under the patient threshold, counts kept', () => {
    expect(filterProfile(stored({ patientsCount: 5 }), options({ minPatients: 11 }))).toEqual({ json: null, rowsCount: 500, patientsCount: 5 })
  })

  it('applies the categories\' minimum, length and top N', () => {
    const json = filterProfile(stored(), options({ minCategoryCount: 100, maxCategoryLength: 20, topN: 1 })).json!
    expect(json.categorical_data).toEqual([{ category: 'high', count: 300, patients_count: 30, percentage: 60 }])
    expect(json.hospital_units).toEqual([{ unit: 'ICU', percentage: 80 }])
  })

  it('gives the sections asked for, and says what kind of values they are', () => {
    const json = filterProfile(stored(), options({ sections: sectionSet(['counts', 'numeric']) })).json!
    expect(Object.keys(json)).toEqual(['full_name', 'data_types', 'numeric_data'])
    expect(json.data_types).toBe('numeric')
  })

  it('drops categories that only repeat the numbers', () => {
    const numbers = stored({ json: { numeric_data: { min: 1 }, categorical_data: [{ category: '80', count: 90 }, { category: '81', count: 60 }] } })
    expect(filterProfile(numbers, options({ minCategoryCount: 1 })).json!.categorical_data).toBeUndefined()
  })
})
