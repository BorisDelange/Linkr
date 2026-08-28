import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { detectEntityKind, detectTreeKind, validateEntity } from './entities.js'

const TREE = JSON.stringify([
  { path: 'queries', type: 'folder', order: 0 },
  { path: 'queries/cohort.sql', type: 'file', order: 0 },
])

function collection(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  return new MemoryTree({
    'entity.json': JSON.stringify({ type: 'sql-collection', name: { en: 'Queries' }, ...over }),
    '_tree.json': TREE,
    'queries/cohort.sql': 'SELECT 1;\n',
    ...files,
  })
}

const PRESET = {
  presetId: 'omop-5-4',
  // Canonical order: declared keys first, unlisted ones (here `tables`) appended
  // sorted — so `eventTables` precedes `tables`. A well-formed fixture has to be
  // in that order, or it trips the legacy-format warning it is meant to not trip.
  mapping: {
    eventTables: {
      Labs: { table: 'measurement', conceptIdColumn: 'measurement_concept_id', dateColumn: 'measurement_date' },
    },
    tables: { person: { columns: { person_id: 'id' } } },
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
    const tree = new MemoryTree({ 'entity.json': '{"type":"sql-collection"}', '_tree.json': '[]' })
    expect(validateEntity(tree, 'sql-collection').some((i) => i.code === 'missing-field')).toBe(true)
  })

  it('flags a file listed in the tree but absent', () => {
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({ type: 'sql-collection', name: { en: 'Q' } }),
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
      'entity.json': JSON.stringify({ type: 'sql-collection', name: { en: 'Q' } }),
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

  it('tolerates an `id` left over from an older tree', () => {
    // Exports no longer write `id` — it was the writing instance's local key.
    // A tree that still carries one imports fine (the importer ignores it), so
    // it is not worth an issue.
    expect(validateEntity(collection({ id: 'col-1' }), 'sql-collection')).toEqual([])
  })

  it('warns about instance-specific fields', () => {
    const issues = validateEntity(collection({ workspaceId: 'ws-1' }), 'sql-collection')
    expect(issues.some((i) => i.code === 'legacy-format')).toBe(true)
  })
})

describe('schema preset', () => {
  const preset = (over: Record<string, unknown> = {}) => {
    const { mapping, ...manifest } = { ...PRESET, ...over }
    return new MemoryTree({
      'entity.json': JSON.stringify({ type: 'schema-preset', ...manifest }),
      'mapping.json': JSON.stringify(mapping),
    })
  }

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
    expect(issues.map((i) => i.path)).toContain('mapping.json')
  })

  it('requires presetId and a mapping', () => {
    const issues = validateEntity(new MemoryTree({ 'entity.json': '{"type":"schema-preset"}' }), 'schema-preset')
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
    // Two checks share the legacy-format code (inline DDL, non-canonical order),
    // and an inline `ddl` is itself out of order — match on the hint, not on
    // whichever warning happens to come first.
    const legacy = issues.find((i) => i.code === 'legacy-format' && i.hint?.includes('schema.ddl'))
    expect(legacy?.severity).toBe('warning')
  })

  it('rejects a mapping whose tables are not objects', () => {
    const issues = validateEntity(preset({ mapping: { tables: [] } }), 'schema-preset')
    expect(issues.some((i) => i.code === 'wrong-type')).toBe(true)
  })
})

// Step 2 of the export-format harmonization: readers accept the new shared
// `entity.json` (with its own `type`) as well as every historical manifest name,
// so a tree written by either format imports cleanly. Writers are unchanged.
describe('entity.json — tolerant reads', () => {
  it('detects a kind from the declared type, with no per-kind filename', () => {
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({ id: 'c1', type: 'sql-collection', name: { en: 'Q' } }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    expect(detectEntityKind(tree)).toBe('sql-collection')
    expect(detectTreeKind(tree)).toBe('sql-collection')
  })

  it('still detects a kind from the historical filename', () => {
    // `collection()` writes entity.json now, so it cannot stand in for this:
    // the point is a tree published BEFORE the rename, carrying only the old
    // per-kind name and no `type` to declare itself.
    const legacy = new MemoryTree({
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    expect(detectEntityKind(legacy)).toBe('sql-collection')
  })

  it('validates a tree that uses entity.json, reporting against that path', () => {
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({ id: 'c1', type: 'sql-collection' }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    const issues = validateEntity(tree, 'sql-collection')
    // `name` is required, so the tree is invalid — the point is WHERE it is
    // reported: entity.json, the file the user actually has, never the
    // historical name it does not.
    expect(issues.some((i) => i.path === 'entity.json')).toBe(true)
    expect(issues.some((i) => i.path === '_collection.json')).toBe(false)
    // ...and entity.json must not itself be reported as an unlisted stray file.
    expect(issues.some((i) => i.code === 'orphan-record')).toBe(false)
  })

  it('tells a mapping project from a plain project by its declared type', () => {
    const asProject = new MemoryTree({
      'entity.json': JSON.stringify({ type: 'project', name: { en: 'P' }, projectId: 'p' }),
    })
    expect(detectTreeKind(asProject)).toBe('project')

    const asMapping = new MemoryTree({
      'entity.json': JSON.stringify({ type: 'mapping-project', name: { en: 'M' } }),
      'mappings.json': JSON.stringify([]),
    })
    expect(detectTreeKind(asMapping)).toBe('mapping-project')
  })

  it('falls back to the filename heuristic when the type is absent or unknown', () => {
    const noType = new MemoryTree({
      'entity.json': JSON.stringify({ name: { en: 'Q' } }),
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    expect(detectEntityKind(noType)).toBe('sql-collection')

    const badType = new MemoryTree({
      'entity.json': JSON.stringify({ type: 'not-a-real-kind' }),
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    expect(detectEntityKind(badType)).toBe('sql-collection')
  })

  it('survives an unparseable entity.json rather than throwing', () => {
    const tree = new MemoryTree({
      'entity.json': '{ not json',
      '_collection.json': JSON.stringify({ name: { en: 'Q' } }),
      '_tree.json': TREE,
      'queries/cohort.sql': 'SELECT 1;\n',
    })
    expect(detectEntityKind(tree)).toBe('sql-collection')
  })
})

describe('canonical shape — what the app would rewrite', () => {
  it('flags an empty badges list, which the app deletes on export', () => {
    const issues = validateEntity(collection({ badges: [] }), 'sql-collection')
    const issue = issues.find((i) => i.code === 'non-canonical')
    expect(issue?.severity).toBe('warning')
    expect(issue?.pointer).toBe('/badges')
  })

  it('accepts a non-empty badges list', () => {
    const issues = validateEntity(collection({ badges: [{ label: 'ICU' }] }), 'sql-collection')
    expect(issues.some((i) => i.code === 'non-canonical')).toBe(false)
  })

  it('flags a file tree that is not sorted by path', () => {
    // The app writes this sorted, so an unsorted tree is rewritten on the first
    // export — a diff on a file the author never meant to touch.
    const unsorted = JSON.stringify([
      { path: 'queries', type: 'folder', order: 0 },
      { path: 'queries/z.sql', type: 'file', order: 0 },
      { path: 'queries/a.sql', type: 'file', order: 1 },
    ])
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({ type: 'sql-collection', name: { en: 'Q' } }),
      '_tree.json': unsorted,
      'queries/z.sql': 'SELECT 1;\n',
      'queries/a.sql': 'SELECT 2;\n',
    })
    const issue = validateEntity(tree, 'sql-collection').find((i) => i.code === 'unsorted-tree')
    expect(issue?.severity).toBe('warning')
    expect(issue?.hint).toContain('queries/a.sql')
  })

  it('accepts a sorted file tree', () => {
    expect(validateEntity(collection(), 'sql-collection')
      .some((i) => i.code === 'unsorted-tree')).toBe(false)
  })
})
