import { describe, expect, it } from 'vitest'
import { commonDirPrefix, extractTableName } from './engine'

const MIMIC_IV_FILES = [
  'admissions', 'caregiver', 'chartevents', 'd_hcpcs', 'd_icd_diagnoses',
  'd_icd_procedures', 'd_items', 'd_labitems', 'datetimeevents', 'diagnoses_icd',
  'drgcodes', 'emar', 'emar_detail', 'hcpcsevents', 'icustays', 'ingredientevents',
  'inputevents', 'labevents', 'microbiologyevents', 'omr', 'outputevents',
  'patients', 'pharmacy', 'poe', 'poe_detail', 'prescriptions', 'procedureevents',
  'procedures_icd', 'provider', 'services', 'transfers',
]

describe('extractTableName', () => {
  it('uses the file name for a flat folder of one-file-per-table', () => {
    expect(extractTableName('mimic-iv-raw-parquet/admissions.parquet')).toBe('admissions')
    expect(extractTableName('mimic-iv-raw-parquet/d_icd_diagnoses.parquet')).toBe('d_icd_diagnoses')
  })

  it('keeps every table distinct in a flat folder, not collapsed to the folder name', () => {
    const paths = MIMIC_IV_FILES.map((n) => `mimic-iv-raw-parquet/${n}.parquet`)
    const tables = new Set(paths.map((p) => extractTableName(p)))
    expect(tables.size).toBe(MIMIC_IV_FILES.length)
    expect(tables.has('mimic-iv-raw-parquet')).toBe(false)
  })

  it('does not let a lone knownTables match hide the other tables', () => {
    const paths = MIMIC_IV_FILES.map((n) => `mimic-iv-raw-parquet/${n}.parquet`)
    const tables = new Set(paths.map((p) => extractTableName(p, ['provider'])))
    expect(tables.size).toBe(MIMIC_IV_FILES.length)
  })

  it('uses the parent directory for Hive/Spark shard layouts', () => {
    expect(extractTableName('warehouse/admissions/part-00000-abc.parquet')).toBe('admissions')
    expect(extractTableName('warehouse/admissions/part-00001-def.parquet')).toBe('admissions')
    expect(extractTableName('export/labevents/chunk_3.parquet')).toBe('labevents')
    expect(extractTableName('export/labevents/0001.parquet')).toBe('labevents')
  })

  it('groups shards of one table together and keeps distinct tables apart', () => {
    const paths = [
      'wh/admissions/part-00000.parquet',
      'wh/admissions/part-00001.parquet',
      'wh/patients/part-00000.parquet',
    ]
    expect(new Set(paths.map((p) => extractTableName(p)))).toEqual(
      new Set(['admissions', 'patients']),
    )
  })

  it('treats a real table whose name starts with a shard keyword as a table', () => {
    expect(extractTableName('wh/data_quality.parquet')).toBe('data_quality')
    expect(extractTableName('wh/file_registry.parquet')).toBe('file_registry')
    expect(extractTableName('wh/partners.parquet')).toBe('partners')
  })

  it('prefers an explicit knownTables match over the file name', () => {
    expect(extractTableName('dump/person/part-00000.parquet', ['person'])).toBe('person')
    expect(extractTableName('omop/PERSON.parquet', ['person'])).toBe('person')
  })

  it('handles bare file names and backslash paths', () => {
    expect(extractTableName('admissions.parquet')).toBe('admissions')
    expect(extractTableName('C:\\data\\mimic\\admissions.parquet')).toBe('admissions')
  })
})

describe('commonDirPrefix', () => {
  it('returns the shared folder of a flat selection', () => {
    expect(commonDirPrefix([
      'mimic-iv-raw-parquet/admissions.parquet',
      'mimic-iv-raw-parquet/patients.parquet',
    ])).toBe('mimic-iv-raw-parquet')
  })

  it('returns the deepest shared directory across nested paths', () => {
    expect(commonDirPrefix([
      'data/wh/admissions/part-0.parquet',
      'data/wh/patients/part-0.parquet',
    ])).toBe('data/wh')
  })

  it('returns empty for bare file names or fully divergent roots', () => {
    expect(commonDirPrefix(['admissions.parquet'])).toBe('')
    expect(commonDirPrefix(['a/x.parquet', 'b/y.parquet'])).toBe('')
    expect(commonDirPrefix([])).toBe('')
  })
})
