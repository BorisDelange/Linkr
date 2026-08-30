import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PROFILE_OPTIONS,
  DEFAULT_PROFILE_SECTIONS,
  assembleProfileJson,
  availableSections,
  buildCategoricalQuery,
  buildCombinedScalarQuery,
  buildConceptProfile,
  buildHistogramQuery,
  buildHospitalUnitsQuery,
  buildNumericStatsQuery,
  buildPerPatientQuery,
  buildProfileBaseQuery,
  effectiveSections,
  frequencyLabel,
  histogramBins,
  outlierBounds,
  resolveProfileSource,
  type ProfileSource,
} from './concept-profile'
import type { SchemaMapping } from '@/types/schema-mapping'

/** An OMOP-shaped mapping: FK join, both concept id columns, a ward lookup. */
const OMOP: SchemaMapping = {
  presetId: 'omop-5.4',
  presetLabel: { en: 'OMOP CDM 5.4' },
  patientTable: { table: 'person', idColumn: 'person_id' },
  visitDetailTable: {
    table: 'visit_detail',
    idColumn: 'visit_detail_id',
    visitIdColumn: 'visit_occurrence_id',
    patientIdColumn: 'person_id',
    startDateColumn: 'visit_detail_start_datetime',
    endDateColumn: 'visit_detail_end_datetime',
    unitColumn: 'care_site_id',
    unitNameTable: 'care_site',
    unitNameIdColumn: 'care_site_id',
    unitNameColumn: 'care_site_name',
  },
  conceptTables: [{ key: 'concept', table: 'concept', idColumn: 'concept_id', nameColumn: 'concept_name' }],
  eventTables: {
    Measurements: {
      table: 'measurement',
      conceptIdColumn: 'measurement_concept_id',
      sourceConceptIdColumn: 'measurement_source_concept_id',
      valueColumn: 'value_as_number',
      valueStringColumn: 'value_source_value',
      valueUnitColumn: 'unit_source_value',
      patientIdColumn: 'person_id',
      dateColumn: 'measurement_datetime',
    },
    Conditions: {
      table: 'condition_occurrence',
      conceptIdColumn: 'condition_concept_id',
      patientIdColumn: 'person_id',
      dateColumn: 'condition_start_datetime',
    },
  },
}

function source(mapping: SchemaMapping = OMOP, key = 'concept'): ProfileSource {
  const resolved = resolveProfileSource(mapping, key)
  if (!resolved) throw new Error('no source')
  return resolved
}

describe('resolveProfileSource', () => {
  it('picks the event table that can support the richest profile', () => {
    // Both tables reference the same dictionary; only one carries values, and a
    // profile built from condition_occurrence would have no distribution at all.
    expect(source().eventTable.table).toBe('measurement')
  })

  it('yields nothing when the schema describes no such dictionary', () => {
    expect(resolveProfileSource(OMOP, 'nope')).toBeNull()
  })

  it('yields nothing when no event table references the dictionary', () => {
    const orphan: SchemaMapping = { ...OMOP, eventTables: {} }
    expect(resolveProfileSource(orphan, 'concept')).toBeNull()
  })
})

describe('availableSections', () => {
  it('offers every section a full schema can back', () => {
    expect(availableSections(OMOP, source())).toEqual(DEFAULT_PROFILE_SECTIONS)
  })

  it('withholds the sections a bare schema cannot produce', () => {
    // The whole point of the preset-driven design: a model with only a code
    // column gets a profile of what it has, not a crash or an empty chart.
    const bare: SchemaMapping = {
      ...OMOP,
      visitDetailTable: undefined,
      eventTables: { Events: { table: 'ev', conceptIdColumn: 'concept_id' } },
    }
    expect(availableSections(bare, source(bare))).toEqual({
      numeric: false, histogram: false, categorical: false, unit: false,
      frequency: false, temporal: false, hospitalUnits: false, missingRate: false,
      // Counting records per patient needs no value and no date — the patient
      // table's own key is enough, so this survives where everything else falls.
      perPatient: true,
    })
  })
})

describe('effectiveSections', () => {
  it('drops a requested section the schema cannot back', () => {
    const available = { ...DEFAULT_PROFILE_SECTIONS, hospitalUnits: false }
    expect(effectiveSections(DEFAULT_PROFILE_SECTIONS, available).hospitalUnits).toBe(false)
  })

  it('drops the histogram when the numeric block is off', () => {
    // The histogram is a view of the same values; keeping it would query a block
    // the user explicitly turned off.
    const requested = { ...DEFAULT_PROFILE_SECTIONS, numeric: false }
    expect(effectiveSections(requested, DEFAULT_PROFILE_SECTIONS).histogram).toBe(false)
  })
})

describe('outlierBounds', () => {
  const row = { p1: 1, p25: 10, median: 20, p75: 30, p99: 99, numeric_count: 100 }

  it('fences at Tukey distance from the quartiles', () => {
    expect(outlierBounds(row, 'iqr', 1.5)).toEqual({ lower: -20, upper: 60 })
  })

  it('centres on the median for mad', () => {
    // The two 1.4826 factors cancel (leaving float residue), so mad differs from
    // iqr only by spanning the median rather than the quartiles.
    const bounds = outlierBounds(row, 'mad', 1.5)!
    expect(bounds.lower).toBeCloseTo(-10)
    expect(bounds.upper).toBeCloseTo(50)
  })

  it('uses the extreme percentiles directly', () => {
    expect(outlierBounds(row, 'percentile', 1.5)).toEqual({ lower: 1, upper: 99 })
  })

  it('excludes nothing when asked not to', () => {
    expect(outlierBounds(row, 'iqr', 1.5)).not.toBeNull()
    expect(outlierBounds(row, 'none', 1.5)).toBeNull()
  })

  it('excludes nothing when there is nothing to fence', () => {
    expect(outlierBounds({ ...row, numeric_count: 0 }, 'iqr', 1.5)).toBeNull()
    expect(outlierBounds({ ...row, p25: null }, 'iqr', 1.5)).toBeNull()
  })
})

describe('histogramBins', () => {
  it('follows Sturges for an auto count', () => {
    expect(histogramBins(1024, 'auto')).toBe(11) // 1 + log2(1024)
  })

  it('caps the count so a huge concept cannot bloat the JSON', () => {
    expect(histogramBins(10 ** 18, 'auto')).toBe(50)
    expect(histogramBins(100, 999)).toBe(50)
  })

  it('never returns a zero bin count, which would divide by zero', () => {
    expect(histogramBins(0, 'auto')).toBeGreaterThanOrEqual(1)
    expect(histogramBins(100, 0)).toBe(1)
  })
})

describe('query builders', () => {
  it('matches a concept through either OMOP concept column', () => {
    // A source concept is named by measurement_concept_id OR
    // measurement_source_concept_id; matching one alone silently halves counts.
    const sql = buildProfileBaseQuery(OMOP, source(), 42)
    expect(sql).toContain('"measurement_concept_id" = 42')
    expect(sql).toContain('"measurement_source_concept_id" = 42')
    expect(sql).toContain('COUNT(DISTINCT e."person_id")')
  })

  it('never interpolates a concept id as text', () => {
    // The id is the only caller-supplied value reaching the SQL; it is coerced to
    // an integer rather than escaped, so an injection attempt cannot survive.
    const sql = buildProfileBaseQuery(OMOP, source(), 7.9)
    expect(sql).toContain('= 7')
    expect(sql).not.toContain('7.9')
  })

  it('applies the outlier fence to the stats and the histogram alike', () => {
    // Stats describing one set and a histogram drawing another would disagree.
    const bounds = { lower: -20, upper: 60 }
    expect(buildNumericStatsQuery(source(), 42, bounds)).toContain('>= -20')
    expect(buildHistogramQuery(source(), 42, bounds, 10)).toContain('<= 60')
  })

  it('bins on the centre, not the edge', () => {
    // The detail view plots x on a linear axis: a left edge would shift every
    // bar half a bin away from the values it counts.
    expect(buildHistogramQuery(source(), 42, null, 10)).toContain('(bin_width / 2)')
  })

  it('keeps rare categories out and takes the top N', () => {
    const sql = buildCategoricalQuery(source(), 42, { minCategoryCount: 50, topN: 10 })
    expect(sql).toContain('HAVING COUNT(*) >= 50')
    expect(sql).toContain('LIMIT 10')
  })

  it('joins the ward through its lookup table', () => {
    const sql = buildHospitalUnitsQuery(OMOP, source(), 42, 10)
    expect(sql).toContain('"care_site"')
    expect(sql).toContain('cs."care_site_name"')
  })

  it('prefers the verbatim ward over the coarser lookup', () => {
    // visit_detail_source_value holds the real unit where the standard concept
    // is far coarser, and many ETLs leave care_site_id NULL entirely.
    const withSourceValue: SchemaMapping = {
      ...OMOP,
      visitDetailTable: { ...OMOP.visitDetailTable!, unitSourceValueColumn: 'visit_detail_source_value' },
    }
    const sql = buildHospitalUnitsQuery(withSourceValue, source(withSourceValue), 42, 10)
    expect(sql).toContain('visit_detail_source_value')
    expect(sql).not.toContain('care_site_name')
  })

  it('counts records per patient by grouping on the patient, not the rows', () => {
    // The distribution is over patients: a plain COUNT(*) would answer "how many
    // records" again, which the base query already reports.
    const sql = buildPerPatientQuery(OMOP, source(), 42)
    expect(sql).toContain('GROUP BY e."person_id"')
    expect(sql).toContain('MIN(n) AS min')
    expect(sql).toContain('MAX(n) AS max')
  })

  it('folds every single-row block into one query', () => {
    // Six round trips per concept was the dominant cost of a run and what
    // stalled the browser tab; these are all aggregates over the same rows.
    const sql = buildCombinedScalarQuery(OMOP, source(), 42, DEFAULT_PROFILE_SECTIONS)
    expect(sql).toContain('COUNT(*) AS rows_count')
    expect(sql).toContain('AS patients_count')
    expect(sql).toContain('AS missing_rate')
    expect(sql).toContain('PERCENTILE_CONT(0.01)')
    expect(sql).toContain('AS per_patient_median')
    expect(sql).toContain('AS median_hours')
  })

  it('leaves out the blocks the caller turned off', () => {
    // Scanning less, not scanning the same and asking once.
    const sql = buildCombinedScalarQuery(OMOP, source(), 42, {
      ...DEFAULT_PROFILE_SECTIONS, missingRate: false, perPatient: false, frequency: false,
    })
    expect(sql).not.toContain('AS missing_rate')
    expect(sql).not.toContain('per_patient')
    expect(sql).not.toContain('median_hours')
    // The counts are unconditional — the caller always needs them.
    expect(sql).toContain('COUNT(*) AS rows_count')
  })

  it('returns nothing for a block the schema cannot back', () => {
    // An empty string, not broken SQL: the caller skips it.
    const bare: SchemaMapping = {
      ...OMOP,
      visitDetailTable: undefined,
      eventTables: { Events: { table: 'ev', conceptIdColumn: 'concept_id' } },
    }
    const s = source(bare)
    expect(buildNumericStatsQuery(s, 42, null)).toBe('')
    expect(buildCategoricalQuery(s, 42, { minCategoryCount: 50, topN: 10 })).toBe('')
    expect(buildHospitalUnitsQuery(bare, s, 42, 10)).toBe('')
  })
})

describe('frequencyLabel', () => {
  it('buckets a median interval into a readable cadence', () => {
    expect(frequencyLabel(0.5)).toBe('per minute')
    expect(frequencyLabel(1.5)).toBe('hourly')
    expect(frequencyLabel(6)).toBe('every 6 hours')
    expect(frequencyLabel(24)).toBe('daily')
    expect(frequencyLabel(72)).toBe('weekly')
    expect(frequencyLabel(500)).toBe('monthly or less')
  })

  it('says nothing rather than guessing from an unusable median', () => {
    expect(frequencyLabel(null)).toBeNull()
    expect(frequencyLabel(undefined)).toBeNull()
    expect(frequencyLabel(0)).toBeNull()
    expect(frequencyLabel(NaN)).toBeNull()
  })
})

describe('assembleProfileJson', () => {
  const base = { rows_count: 1000, patients_count: 200 }

  it('emits the shape the concept detail view reads', () => {
    const json = assembleProfileJson({
      base,
      numeric: { min: 1, p5: 2, p25: 3, median: 4, mean: 5, p75: 6, p95: 7, max: 8, sd: 9 },
      histogram: [{ x: 1.5, count: 10 }],
      categorical: [{ category: 'POS', count: 60, percentage: 60 }],
      unit: { unit: 'mmHg' },
      frequency: { median_hours: 6 },
      missingRate: { missing_rate: 2.5 },
      temporal: [{ year: 2020, percentage: 100, start_date: '2020-01-01', end_date: '2020-12-31' }],
      hospitalUnits: [{ unit: 'ICU', percentage: 80 }],
    }, { fullName: 'Systolic BP', dataSource: 'OMOP CDM 5.4' }, DEFAULT_PROFILE_OPTIONS)

    expect(json).toEqual({
      full_name: 'Systolic BP',
      data_source: 'OMOP CDM 5.4',
      data_types: ['numeric', 'categorical'],
      unit: 'mmHg',
      numeric_data: { min: 1, p5: 2, p25: 3, median: 4, mean: 5, p75: 6, p95: 7, max: 8, sd: 9 },
      histogram: [{ x: 1.5, count: 10 }],
      categorical_data: [{ category: 'POS', count: 60, percentage: 60 }],
      measurement_frequency: { typical_interval: 'every 6 hours' },
      missing_rate: 2.5,
      temporal_distribution: {
        start_date: '2020-01-01',
        end_date: '2020-12-31',
        by_year: [{ year: 2020, percentage: 100 }],
      },
      hospital_units: [{ unit: 'ICU', percentage: 80 }],
    })
  })

  it('withholds the profile below the k-anonymity threshold', () => {
    // An aggregate over a handful of patients is not an aggregate. The caller
    // still keeps the concept — only the JSON is withheld.
    const json = assembleProfileJson(
      { base: { rows_count: 30, patients_count: 3 }, numeric: { min: 1, max: 2 } },
      {}, DEFAULT_PROFILE_OPTIONS,
    )
    expect(json).toBeNull()
  })

  it('masks a categorical value too long to be one', () => {
    // A long "category" is free text that was never meant to be one, and free
    // text from a clinical record must not travel in an exported profile.
    const json = assembleProfileJson({
      base,
      categorical: [
        { category: 'x'.repeat(200), count: 60, percentage: 60 },
        { category: 'POS', count: 40, percentage: 40 },
      ],
    }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(json?.categorical_data).toEqual([{ category: 'POS', count: 40, percentage: 40 }])
  })

  it('drops categories that are only the numeric values as text', () => {
    // MIMIC's chartevents keeps a measurement twice — `valuenum` and `value`,
    // the latter the former as a string — so a heart rate would report a numeric
    // distribution AND a category list of "80", "81", "82": the same data twice.
    const json = assembleProfileJson({
      base,
      numeric: { min: 60, max: 100, median: 80 },
      categorical: [
        { category: '80', count: 60, percentage: 60 },
        { category: '81', count: 40, percentage: 40 },
      ],
    }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(json?.categorical_data).toBeUndefined()
    expect(json?.data_types).toBe('numeric')
  })

  it('keeps numeric-looking categories when there is no numeric block', () => {
    // A genuinely categorical concept coded 0/1 has nothing to duplicate, so the
    // suppression above must not reach it.
    const json = assembleProfileJson({
      base,
      categorical: [
        { category: '0', count: 60, percentage: 60 },
        { category: '1', count: 40, percentage: 40 },
      ],
    }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(json?.categorical_data).toHaveLength(2)
    expect(json?.data_types).toBe('categorical')
  })

  it('reports how many records one patient has', () => {
    // Records and patients alone cannot separate a once-per-stay concept from a
    // per-minute one: 1000 rows over 200 patients is a different variable
    // depending on whether the rows are spread evenly or piled on one patient.
    const json = assembleProfileJson({
      base,
      perPatient: { mean: 5, median: 4, min: 1, max: 90 },
    }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(json?.records_per_patient).toEqual({ mean: 5, median: 4, min: 1, max: 90 })
  })

  it('omits absent keys rather than emitting nulls', () => {
    // The renderer shows any unrecognised top-level scalar as a text row, so a
    // null would surface as a blank line in the UI.
    const json = assembleProfileJson({ base }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(json).toEqual({})
    expect(Object.keys(json!)).not.toContain('unit')
  })

  it('names a single data type as a string, both as an array', () => {
    const numeric = assembleProfileJson({ base, numeric: { min: 1, max: 2 } }, {}, DEFAULT_PROFILE_OPTIONS)
    expect(numeric?.data_types).toBe('numeric')
  })

  it('drops a numeric stat that came back null', () => {
    const json = assembleProfileJson(
      { base, numeric: { min: 1, max: 5, sd: null, median: 3 } }, {}, DEFAULT_PROFILE_OPTIONS,
    )
    expect(json?.numeric_data).toEqual({ min: 1, median: 3, max: 5 })
  })
})

describe('buildConceptProfile', () => {
  /** A fake engine answering each block by matching its SQL. */
  function engine(answers: { match: string; rows: Record<string, unknown>[] }[]) {
    const seen: string[] = []
    const query = async (sql: string) => {
      seen.push(sql)
      return answers.find((a) => sql.includes(a.match))?.rows ?? []
    }
    return { query, seen }
  }

  it('assembles a profile from the executed blocks', async () => {
    const { query, seen } = engine([
      // Counts, percentiles, missing rate, unit, frequency and per-patient all
      // come back in ONE row: they are single-row aggregates over the same
      // scope, and asking them separately was six round trips per concept.
      {
        match: 'rows_count',
        rows: [{
          rows_count: 1000, patients_count: 200,
          p1: 1, p25: 10, median: 20, p75: 30, p99: 99, numeric_count: 500,
          missing_rate: 2.5, unit: 'mmHg', median_hours: 6,
          per_patient_mean: 5, per_patient_median: 4, per_patient_min: 1, per_patient_max: 90,
        }],
      },
      { match: 'STDDEV', rows: [{ min: 1, max: 60, mean: 20, median: 20, sd: 5 }] },
      { match: 'bin_width', rows: [{ x: 5, count: 100 }] },
    ])
    const result = await buildConceptProfile(OMOP, source(), { conceptId: 42 }, DEFAULT_PROFILE_OPTIONS, query)
    expect(result.rowsCount).toBe(1000)
    expect(result.patientsCount).toBe(200)
    expect(result.json?.numeric_data).toMatchObject({ min: 1, max: 60 })
    expect(result.json?.histogram).toEqual([{ x: 5, count: 100 }])
    // Everything the combined row carried lands without its own query.
    expect(result.json?.missing_rate).toBe(2.5)
    expect(result.json?.unit).toBe('mmHg')
    expect(result.json?.measurement_frequency).toEqual({ typical_interval: 'every 6 hours' })
    expect(result.json?.records_per_patient).toEqual({ mean: 5, median: 4, min: 1, max: 90 })
    // Four queries for a full profile, not eleven: the combined row, the trimmed
    // stats it makes possible, the histogram, then the multi-row blocks.
    expect(seen.filter((s) => s.includes('rows_count'))).toHaveLength(1)
    expect(seen.length).toBeLessThanOrEqual(6)
  })

  it('stops before the expensive blocks when the concept is too rare', async () => {
    // Below the threshold the JSON is withheld anyway, so scanning the event
    // table for it would be pure waste.
    const { query, seen } = engine([
      { match: 'rows_count', rows: [{ rows_count: 9, patients_count: 2 }] },
    ])
    const result = await buildConceptProfile(OMOP, source(), { conceptId: 42 }, DEFAULT_PROFILE_OPTIONS, query)
    expect(result.json).toBeNull()
    expect(result.patientsCount).toBe(2)
    expect(seen).toHaveLength(1)
  })

  it('survives a block that fails', async () => {
    // One malformed date column must not cost the whole extraction.
    const query = async (sql: string) => {
      if (sql.includes('rows_count')) return [{ rows_count: 1000, patients_count: 200 }]
      throw new Error('bad column')
    }
    const result = await buildConceptProfile(OMOP, source(), { conceptId: 42 }, DEFAULT_PROFILE_OPTIONS, query)
    expect(result.rowsCount).toBe(1000)
    // The schema's own name still lands: it is metadata, not a queried block.
    expect(result.json).toEqual({ data_source: 'OMOP CDM 5.4' })
  })

  it('never queries a section the caller turned off', async () => {
    const { query, seen } = engine([
      { match: 'rows_count', rows: [{ rows_count: 1000, patients_count: 200 }] },
    ])
    await buildConceptProfile(
      OMOP, source(), { conceptId: 42 },
      { ...DEFAULT_PROFILE_OPTIONS, sections: { ...DEFAULT_PROFILE_SECTIONS, hospitalUnits: false, temporal: false } },
      query,
    )
    expect(seen.some((s) => s.includes('care_site'))).toBe(false)
    expect(seen.some((s) => s.includes('EXTRACT(YEAR'))).toBe(false)
  })
})
