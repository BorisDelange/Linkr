import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { detectEntityKind, validateEntity } from './entities.js'

const TREE = JSON.stringify([
  { path: 'queries', type: 'folder', order: 0 },
  { path: 'queries/cohort.sql', type: 'file', order: 0 },
])

function collection(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  return new MemoryTree({
    '_collection.json': JSON.stringify({ name: { en: 'Queries' }, ...over }),
    '_tree.json': TREE,
    'queries/cohort.sql': 'SELECT 1;\n',
    ...files,
  })
}

const PRESET = {
  presetId: 'omop-5-4',
  mapping: {
    tables: { person: { columns: { person_id: 'id' } } },
    eventTables: {
      Labs: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_date' },
    },
  },
}

describe('detectEntityKind', () => {
  it('identifies each kind from its metadata file', () => {
    expect(detectEntityKind(collection())).toBe('sql-collection')
    expect(detectEntityKind(new MemoryTree({ '_pipeline.json': '{}' }))).toBe('etl-pipeline')
    expect(detectEntityKind(new MemoryTree({ 'preset.json': '{}' }))).toBe('schema-preset')
  })

  it('returns null for a tree that is not a standalone entity', () => {
    expect(detectEntityKind(new MemoryTree({ 'project.json': '{}' }))).toBeNull()
  })
})

describe('sql collection / etl pipeline', () => {
  it('accepts a well-formed collection', () => {
    expect(validateEntity(collection(), 'sql-collection')).toEqual([])
  })

  it('requires the metadata file', () => {
    const issues = validateEntity(new MemoryTree({ '_tree.json': '[]' }), 'sql-collection')
    expect(issues[0].code).toBe('missing-file')
  })

  it('requires a name', () => {
    const tree = new MemoryTree({ '_collection.json': '{}', '_tree.json': '[]' })
    expect(validateEntity(tree, 'sql-collection').some((i) => i.code === 'missing-field')).toBe(true)
  })

  it('flags a file listed in the tree but absent', () => {
    const tree = new MemoryTree({
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': TREE,
    })
    const issues = validateEntity(tree, 'sql-collection')
    expect(issues.some((i) => i.code === 'missing-file')).toBe(true)
  })

  it('warns about a file present but unlisted', () => {
    const issues = validateEntity(collection({}, { 'stray.sql': 'SELECT 2;\n' }), 'sql-collection')
    const orphan = issues.find((i) => i.code === 'orphan-record')
    expect(orphan?.severity).toBe('warning')
    expect(orphan?.hint).toContain('stray.sql')
  })

  it('flags a file whose parent folder the tree does not declare', () => {
    const tree = new MemoryTree({
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': JSON.stringify([{ path: 'deep/q.sql', type: 'file', order: 0 }]),
      'deep/q.sql': 'SELECT 1;\n',
    })
    // Without the folder entry the import reparents the file to the root and the
    // authored layout silently flattens.
    expect(validateEntity(tree, 'sql-collection').some((i) => i.code === 'orphan-record')).toBe(true)
  })

  it('ignores README and LICENSE, which are never in the tree', () => {
    const issues = validateEntity(
      collection({}, { 'README.md': '# hi', 'README.fr.md': '# salut', 'LICENSE.md': 'MIT' }),
      'sql-collection',
    )
    expect(issues).toEqual([])
  })

  it('keeps `id` — it is the portable identity, not a local key', () => {
    // The golden fixtures carry `id` on a standalone entity; only a project's
    // `uid` is regenerated on import.
    expect(validateEntity(collection({ id: 'col-1' }), 'sql-collection')).toEqual([])
  })

  it('warns about instance-specific fields', () => {
    const issues = validateEntity(collection({ workspaceId: 'ws-1' }), 'sql-collection')
    expect(issues.some((i) => i.code === 'legacy-format')).toBe(true)
  })
})

describe('schema preset', () => {
  const preset = (over: Record<string, unknown> = {}) =>
    new MemoryTree({ 'preset.json': JSON.stringify({ ...PRESET, ...over }) })

  it('accepts a well-formed preset', () => {
    expect(validateEntity(preset(), 'schema-preset')).toEqual([])
  })

  it('warns when the mapping is not in canonical order', () => {
    // The four published schema repos predate the canonical sort, so the first
    // re-export rewrites their mapping — a diff that changes no data. Silence
    // here is what let that go unnoticed until someone diffed a repo by hand.
    const issues = validateEntity(
      preset({
        mapping: {
          presetLabel: { en: 'P' },
          presetId: 'p',
          eventTables: {
            Measurement: { table: 'measurement', conceptIdColumn: 'c', dateColumn: 'd' },
            Condition: { table: 'condition', conceptIdColumn: 'c', dateColumn: 'd' },
          },
        },
      }),
      'schema-preset',
    )
    expect(issues.map((i) => i.pointer)).toContain('/mapping')
  })

  it('requires presetId and a mapping', () => {
    const issues = validateEntity(new MemoryTree({ 'preset.json': '{}' }), 'schema-preset')
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(2)
  })

  it('requires the fields an event table cannot be queried without', () => {
    const issues = validateEntity(
      preset({ mapping: { eventTables: { Labs: { table: 'measurement' } } } }),
      'schema-preset',
    )
    // conceptIdColumn and dateColumn are both missing.
    expect(issues.filter((i) => i.code === 'missing-field')).toHaveLength(2)
  })

  it('warns when the DDL is inline instead of in schema.ddl', () => {
    const issues = validateEntity(
      preset({ mapping: { ...PRESET.mapping, ddl: 'CREATE TABLE person ();' } }),
      'schema-preset',
    )
    const legacy = issues.find((i) => i.code === 'legacy-format')
    expect(legacy?.severity).toBe('warning')
    expect(legacy?.hint).toContain('schema.ddl')
  })

  it('rejects a mapping whose tables are not objects', () => {
    const issues = validateEntity(preset({ mapping: { tables: [] } }), 'schema-preset')
    expect(issues.some((i) => i.code === 'wrong-type')).toBe(true)
  })
})
