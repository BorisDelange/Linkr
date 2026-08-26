import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { detectTreeKind, validateEntity } from '../validate/entities.js'
import { serializeDatabase, type DatabaseSpec } from './database.js'

const MAPPING = {
  presetId: 'mimic-iv',
  presetLabel: { en: 'MIMIC-IV', fr: 'MIMIC-IV' },
  patientTable: { table: 'patients', idColumn: 'subject_id' },
}

const SPEC: DatabaseSpec = {
  id: 'mimic-iv-demo',
  alias: 'mimic_iv_demo',
  name: { en: 'MIMIC-IV Demo', fr: 'MIMIC-IV démo' },
  description: { en: 'Public demo subset, ODbL 1.0.' },
  schema: MAPPING,
  schemaSource: {
    lineageId: 'lin-mimic-iv',
    label: { en: 'MIMIC-IV', fr: 'MIMIC-IV' },
  },
  tables: [
    { name: 'patients', source: '/data/patients.parquet' },
    { name: 'admissions', source: '/data/admissions.parquet' },
  ],
}

/** The tree as it exists once the caller has performed the declared copies. */
function treeOf(spec: DatabaseSpec): MemoryTree {
  const { files, copies } = serializeDatabase(spec)
  return new MemoryTree({
    ...Object.fromEntries(files.map((f) => [f.path, f.content])),
    ...Object.fromEntries(copies.map((c) => [c.path, 'PARQUET'])),
  })
}

describe('serializeDatabase', () => {
  it('produces a tree its own validator accepts', () => {
    const tree = treeOf(SPEC)
    expect(detectTreeKind(tree)).toBe('database')
    expect(validateEntity(tree, 'database')).toEqual([])
  })

  it('declares the Parquet as copies, never as generated content', () => {
    // The serializer has no I/O and must never hold megabytes of binary: it
    // says where each file goes and the caller moves the bytes.
    const { files, copies } = serializeDatabase(SPEC)
    expect(files.map((f) => f.path).sort()).toEqual(['.gitattributes', 'entity.json'])
    expect(copies).toEqual([
      { path: 'data/admissions.parquet', source: '/data/admissions.parquet' },
      { path: 'data/patients.parquet', source: '/data/patients.parquet' },
    ])
  })

  it('tracks Parquet with LFS', () => {
    // Multi-MB blobs in normal git history bloat every clone forever, and the
    // server's clone resolves LFS pointers before the app sees the tree.
    const tree = treeOf(SPEC)
    expect(tree.read('.gitattributes')).toContain('*.parquet filter=lfs')
  })

  it('is deterministic and sorts tables', () => {
    const reversed: DatabaseSpec = { ...SPEC, tables: [...SPEC.tables!].reverse() }
    expect(serializeDatabase(SPEC)).toEqual(serializeDatabase(reversed))
    const meta = JSON.parse(treeOf(SPEC).read('entity.json')!) as { tables: string[] }
    expect(meta.tables).toEqual(['admissions', 'patients'])
  })

  it('never writes a connection config', () => {
    // The repo is public; a host or a token in it is a credential leak, which
    // is why the app's own export strips this to `engine`.
    const meta = JSON.parse(treeOf(SPEC).read('entity.json')!) as Record<string, unknown>
    expect(meta.connectionConfig).toBeUndefined()
  })

  it('accepts an inline mapping and orders it canonically', () => {
    const tree = treeOf({
      ...SPEC,
      schema: {
        presetId: 'custom',
        presetLabel: { en: 'Custom' },
        eventTables: {
          Zeta: { dateColumn: 'd', conceptIdColumn: 'c', table: 't' },
          Alpha: { table: 't', conceptIdColumn: 'c', dateColumn: 'd' },
        },
      },
    })
    const meta = JSON.parse(tree.read('entity.json')!) as {
      schema: { eventTables: Record<string, Record<string, string>> }
    }
    expect(Object.keys(meta.schema.eventTables)).toEqual(['Alpha', 'Zeta'])
    expect(Object.keys(meta.schema.eventTables.Zeta)).toEqual(['table', 'conceptIdColumn', 'dateColumn'])
  })

  it('allows an in-memory database with no tables', () => {
    // An ETL target starts empty by design; requiring tables would make it
    // impossible to publish one.
    const { files, copies } = serializeDatabase({
      id: 'etl-target', alias: 'target', name: { en: 'Target' },
      schema: MAPPING, schemaSource: SPEC.schemaSource, inMemory: true,
    })
    expect(copies).toEqual([])
    expect(files.map((f) => f.path)).toEqual(['entity.json'])
    const tree = new MemoryTree(Object.fromEntries(files.map((f) => [f.path, f.content])))
    expect(validateEntity(tree, 'database')).toEqual([])
  })

  it('refuses a database with neither tables nor inMemory', () => {
    // Silently writing an empty database imports as one with no data and no
    // explanation, so this fails at authoring time instead.
    expect(() => serializeDatabase({
      id: 'empty', alias: 'empty', name: { en: 'Empty' }, schema: MAPPING,
    })).toThrow(/no tables/)
  })

  it('refuses a duplicate table name', () => {
    // Both would land on data/<name>.parquet: the second silently overwrites
    // the first and the database imports with a table missing.
    expect(() => serializeDatabase({
      ...SPEC,
      tables: [
        { name: 'patients', source: '/a.parquet' },
        { name: 'patients', source: '/b.parquet' },
      ],
    })).toThrow(/twice/)
  })
})

describe('validateEntity(database)', () => {
  it('flags a connection config as an error', () => {
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: MAPPING, schemaSource: SPEC.schemaSource, tables: [],
        connectionConfig: { engine: 'postgres', host: 'db.chu.fr', password: 's3cret' },
      }),
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.severity === 'error' && i.pointer === '/connectionConfig')).toBe(true)
  })

  it('warns when a declared table has no file', () => {
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: MAPPING, schemaSource: SPEC.schemaSource, tables: ['person'],
      }),
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('person'))).toBe(true)
  })

  it('warns when a Parquet file is present but undeclared', () => {
    // It would ship in the repo and never load — the silent half of a mismatch.
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: MAPPING, schemaSource: SPEC.schemaSource, tables: ['person'],
      }),
      'data/person.parquet': 'PARQUET',
      'data/orphan.parquet': 'PARQUET',
      '.gitattributes': '*.parquet filter=lfs diff=lfs merge=lfs -text\n',
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.message.includes('orphan'))).toBe(true)
  })

  it('warns when Parquet is present without LFS tracking', () => {
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: MAPPING, schemaSource: SPEC.schemaSource, tables: ['person'],
      }),
      'data/person.parquet': 'PARQUET',
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.path === '.gitattributes')).toBe(true)
  })

  it('rejects a schema given as a bare name', () => {
    // A name only resolves against presets installed on the importing instance,
    // and the built-in table that used to answer those lookups is being retired.
    // A repo naming its schema is not self-contained.
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: 'omop-5.4', tables: [],
      }),
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.severity === 'error' && i.pointer === '/schema')).toBe(true)
  })

  it('warns when nothing records where the schema came from', () => {
    // Without provenance the app cannot name the schema once its preset is gone,
    // nor recognize two copies of the same one across instances.
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({
        id: 'x', alias: 'x', name: { en: 'X' }, schema: MAPPING, tables: [],
      }),
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.pointer === '/schemaSource')).toBe(true)
  })

  it('requires a schema', () => {
    const tree = new MemoryTree({
      '_database.json': JSON.stringify({ id: 'x', alias: 'x', name: { en: 'X' }, tables: [] }),
    })
    const issues = validateEntity(tree, 'database')
    expect(issues.some((i) => i.severity === 'error' && i.pointer === '/schema')).toBe(true)
  })
})
