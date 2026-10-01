import { describe, expect, it } from 'vitest'
import { commonDirPrefix, defaultSchemaAliases, extractTableName, extractTableRef, fileGroupingTables, groupFilesByTable } from './engine'

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

  it('uses the parent directory for shards named after it', () => {
    expect(extractTableName('db/document/document_1.parquet')).toBe('document')
    expect(extractTableName('db/document/document-2.parquet')).toBe('document')
    expect(extractTableName('db/document/document_1999-01.parquet')).toBe('document')
  })

  it('keeps tables that merely share their schema directory prefix', () => {
    expect(extractTableName('db/ehop/ehop_patient.parquet')).toBe('ehop_patient')
    expect(extractTableName('db/document/document_type.parquet')).toBe('document_type')
  })

  it('matches knownTables case-insensitively', () => {
    expect(extractTableName('db/document/part-0.parquet', ['DOCUMENT'])).toBe('document')
    expect(extractTableName('db/Document.parquet', ['app.DOCUMENT'])).toBe('document')
  })

  it('lets a known directory claim only the files that name no table of their own', () => {
    expect(extractTableName('db/document/document_type.parquet', ['app.document'])).toBe('document_type')
    expect(extractTableName('db/document/doc_a.parquet', ['document'])).toBe('doc_a')
    expect(extractTableName('db/document/1999-01.parquet', ['document'])).toBe('document')
    expect(extractTableName('db/document/document_2.parquet', ['document'])).toBe('document')
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

describe('extractTableRef', () => {
  // The root is what the user picked; a directory BELOW it is a schema. Without
  // that distinction the selected folder itself would become a schema, and every
  // flat import would land in `mimic-iv-raw-parquet`.
  it('reads a module directory as the schema', () => {
    expect(extractTableRef('mimic-iv/hosp/patients.parquet', 'mimic-iv'))
      .toEqual({ schema: 'hosp', table: 'patients' })
    expect(extractTableRef('mimic-iv/icu/icustays.parquet', 'mimic-iv'))
      .toEqual({ schema: 'icu', table: 'icustays' })
  })

  it('gives no schema to a flat folder — the selected root is not a schema', () => {
    expect(extractTableRef('mimic-iv-raw-parquet/admissions.parquet', 'mimic-iv-raw-parquet'))
      .toEqual({ schema: undefined, table: 'admissions' })
  })

  it('keeps the shard layout working, with and without a schema', () => {
    expect(extractTableRef('wh/icu/chartevents/part-00000.parquet', 'wh'))
      .toEqual({ schema: 'icu', table: 'chartevents' })
    expect(extractTableRef('wh/admissions/part-00000.parquet', 'wh'))
      .toEqual({ schema: undefined, table: 'admissions' })
  })

  it('separates two same-named tables into their own schemas', () => {
    // eHOP 4.4: EDBM_EDS.EHOP_PATIENT is de-identified, EDBM_ZPAT.EHOP_PATIENT
    // is nominative. Flattened, one of them is simply lost.
    const a = extractTableRef('ehop/EDBM_EDS/EHOP_PATIENT.parquet', 'ehop')
    const b = extractTableRef('ehop/EDBM_ZPAT/EHOP_PATIENT.parquet', 'ehop')
    expect(a).toEqual({ schema: 'edbm_eds', table: 'ehop_patient' })
    expect(b).toEqual({ schema: 'edbm_zpat', table: 'ehop_patient' })
  })

  it('still honours knownTables, and does not mistake the match for a schema', () => {
    expect(extractTableRef('mimic-iv/hosp/patients.parquet', 'mimic-iv', ['patients']))
      .toEqual({ schema: 'hosp', table: 'patients' })
  })

  it('ignores a root that does not prefix the path, and bare names', () => {
    expect(extractTableRef('admissions.parquet', '')).toEqual({ schema: undefined, table: 'admissions' })
    expect(extractTableRef('hosp/patients.parquet', 'elsewhere'))
      .toEqual({ schema: 'hosp', table: 'patients' })
  })

  it('takes only the directory just above the table, however deep the path', () => {
    expect(extractTableRef('a/b/c/hosp/patients.parquet', 'a/b/c'))
      .toEqual({ schema: 'hosp', table: 'patients' })
  })

  it('agrees with extractTableName on the table part', () => {
    for (const p of [
      'mimic-iv-raw-parquet/admissions.parquet',
      'wh/admissions/part-00000.parquet',
      'omop/PERSON.parquet',
    ]) {
      expect(extractTableRef(p, '').table).toBe(extractTableName(p))
    }
  })
})

describe('groupFilesByTable', () => {
  const file = (fileName: string) => ({ fileName, data: new ArrayBuffer(0) } as never)

  it('keys a flat folder by the bare table name', () => {
    const g = groupFilesByTable([
      file('mimic-iv-raw-parquet/patients.parquet'),
      file('mimic-iv-raw-parquet/admissions.parquet'),
    ])
    expect([...g.keys()].sort()).toEqual(['admissions', 'patients'])
  })

  it('keys a module folder by schema.table', () => {
    const g = groupFilesByTable([
      file('mimic-iv/hosp/patients.parquet'),
      file('mimic-iv/icu/icustays.parquet'),
    ])
    expect([...g.keys()].sort()).toEqual(['hosp.patients', 'icu.icustays'])
  })

  it('keeps two same-named tables of different schemas apart', () => {
    // Flattened, one of these silently swallowed the other's file.
    const g = groupFilesByTable([
      file('ehop/EDBM_EDS/EHOP_PATIENT.parquet'),
      file('ehop/EDBM_ZPAT/EHOP_PATIENT.parquet'),
    ])
    expect([...g.keys()].sort()).toEqual(['edbm_eds.ehop_patient', 'edbm_zpat.ehop_patient'])
    expect(g.get('edbm_eds.ehop_patient')).toHaveLength(1)
  })

  it('still groups the shards of one table together', () => {
    const g = groupFilesByTable([
      file('wh/icu/chartevents/part-00000.parquet'),
      file('wh/icu/chartevents/part-00001.parquet'),
      file('wh/hosp/patients.parquet'),
    ])
    expect([...g.keys()].sort()).toEqual(['hosp.patients', 'icu.chartevents'])
    expect(g.get('icu.chartevents')).toHaveLength(2)
  })

  it('selecting a single table\'s shard directory yields no schema', () => {
    // The root is whatever the selection shares, so picking `wh/icu/chartevents`
    // itself leaves nothing above the table — and no schema to read.
    const g = groupFilesByTable([
      file('wh/icu/chartevents/part-00000.parquet'),
      file('wh/icu/chartevents/part-00001.parquet'),
    ])
    expect([...g.keys()]).toEqual(['chartevents'])
    expect(g.get('chartevents')).toHaveLength(2)
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

describe('fileGroupingTables', () => {
  it('merges knownTables with the tables the DDL declares, lower-cased and schema-qualified', () => {
    const ddl = 'CREATE TABLE visit (\n  id INTEGER\n);\nCREATE TABLE "Edbm"."DOCUMENT" (\n  id INTEGER\n);'
    expect(new Set(fileGroupingTables({ knownTables: ['Person'], ddl } as never))).toEqual(
      new Set(['person', 'visit', 'edbm.document']),
    )
  })

  it('places a flat import in the schema the DDL gives each table', () => {
    const ddl = [
      'CREATE TABLE "APP"."visit" (\n  id INTEGER\n);',
      'CREATE TABLE "APP"."document" (\n  id INTEGER\n);',
      'CREATE TABLE "APP"."patient" (\n  id INTEGER\n);',
      'CREATE TABLE "NOMINATIVE"."patient" (\n  id INTEGER\n);',
    ].join('\n')
    const known = fileGroupingTables({ ddl } as never)
    const files = ['db/visit.parquet', 'db/document/document_1.parquet', 'db/document/1999-01.parquet', 'db/patient.parquet', 'db/other.parquet']
      .map((fileName) => ({ fileName }) as never)
    // `patient` is declared in two schemas, so it is left unplaced rather than guessed.
    expect([...groupFilesByTable(files, known).keys()].sort()).toEqual(['app.document', 'app.visit', 'other', 'patient'])
  })

  it('keeps the schema a module directory gives over the DDL one', () => {
    expect(extractTableRef('db/zone/visit.parquet', 'db', ['app.visit'])).toEqual({ schema: 'zone', table: 'visit' })
  })

  it('returns undefined when the mapping names no table', () => {
    expect(fileGroupingTables(undefined)).toBeUndefined()
    expect(fileGroupingTables({} as never)).toBeUndefined()
  })

  it('groups a folder of dated shards into the DDL table, with no schema', () => {
    const known = fileGroupingTables({ ddl: 'CREATE TABLE document (\n  id INTEGER\n);' } as never)
    const files = ['db/visit.parquet', 'db/document/1999-01.parquet', 'db/document/1999-02.parquet']
      .map((fileName) => ({ fileName }) as never)
    expect([...groupFilesByTable(files, known).keys()].sort()).toEqual(['document', 'visit'])
  })
})

describe('defaultSchemaAliases', () => {
  it('aliases in main each table a flat import placed in a DDL schema', () => {
    const known = ['hosp.admissions', 'icu.icustays']
    const files = ['mimic/admissions.parquet', 'mimic/icustays.parquet', 'mimic/other.parquet']
    expect([...defaultSchemaAliases(files, known)]).toEqual([
      ['admissions', 'hosp.admissions'],
      ['icustays', 'icu.icustays'],
    ])
  })

  it('leaves a module directory alone — its schema is real, not borrowed', () => {
    expect(defaultSchemaAliases(['mimic/hosp/admissions.parquet', 'mimic/icu/icustays.parquet'], ['hosp.admissions']).size).toBe(0)
  })
})
