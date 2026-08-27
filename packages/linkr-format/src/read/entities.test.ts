/**
 * The acceptance gate for editing a standalone entity: serialize → read → serialize
 * must reproduce the same tree.
 *
 * Same contract as the dashboard reader, for the six kinds that live in their own
 * repo. It is what makes `read_entity` + `write_entity` a safe edit loop rather
 * than a way to quietly drop whatever the spec does not model — an ETL pipeline's
 * run status, an entity's organization snapshot, a script's order.
 */
import { describe, expect, it } from 'vitest'
import { MemoryTree } from '../tree.js'
import { serializeEntity } from '../serialize/entities.js'
import type {
  DataCatalogSpec, DqRuleSetSpec, EtlPipelineSpec, MappingProjectSpec, SqlCollectionSpec,
} from '../serialize/entities.js'
import { readEntity, type ReadableEntityKind } from './entities.js'

/** Serialize a spec into a tree the reader can consume. */
function treeOf(kind: Parameters<typeof serializeEntity>[0], spec: never): MemoryTree {
  return new MemoryTree(
    Object.fromEntries(serializeEntity(kind, spec).map((f) => [f.path, f.content])),
  )
}

/** serialize → read → serialize, as the file map both times. */
function roundTrip(kind: ReadableEntityKind, spec: unknown) {
  const first = serializeEntity(kind as never, spec as never)
  const tree = new MemoryTree(Object.fromEntries(first.map((f) => [f.path, f.content])))
  const { spec: back } = readEntity(tree, kind)
  const second = serializeEntity(kind as never, back as never)
  return { first, second }
}

const IDENTITY = {
  entityId: 'icu-queries',
  lineageId: '11111111-2222-3333-4444-555555555555',
  createdAt: '2026-01-02T03:04:05.000Z',
  version: '1.2.0',
}

describe('readEntity — sql-collection / etl-pipeline', () => {
  const COLLECTION: SqlCollectionSpec = {
    ...IDENTITY,
    name: { en: 'ICU queries', fr: 'Requêtes réa' },
    description: { en: 'Cohort helpers' },
    files: [
      { path: 'cohort/01_stays.sql', content: 'SELECT 1;\n', order: 0 },
      { path: '00_setup.sql', content: 'SELECT 0;\n', order: 1 },
    ],
  }

  it('round-trips byte for byte', () => {
    const { first, second } = roundTrip('sql-collection', COLLECTION)
    expect(second).toEqual(first)
  })

  it('keeps the file order, which is what a pipeline runs by', () => {
    const tree = treeOf('sql-collection', COLLECTION as never)
    const { spec } = readEntity(tree, 'sql-collection')
    const files = (spec as SqlCollectionSpec).files
    // Sorted by path in the tree, but each keeps the order it declared.
    expect(files.find((f) => f.path === '00_setup.sql')?.order).toBe(1)
    expect(files.find((f) => f.path === 'cohort/01_stays.sql')?.order).toBe(0)
  })

  it('does not bring folders back as files', () => {
    // The serializer derives folder entries from the file paths; carrying them
    // back would double them on the next write.
    const tree = treeOf('sql-collection', COLLECTION as never)
    const { spec } = readEntity(tree, 'sql-collection')
    expect((spec as SqlCollectionSpec).files.map((f) => f.path).sort())
      .toEqual(['00_setup.sql', 'cohort/01_stays.sql'])
  })

  it('keeps an ETL pipeline status', () => {
    const pipeline: EtlPipelineSpec = {
      ...IDENTITY, entityId: 'mimic-etl',
      name: { en: 'MIMIC ETL' },
      status: 'ready',
      files: [{ path: '01_person.sql', content: 'SELECT 1;\n' }],
    }
    const { first, second } = roundTrip('etl-pipeline', pipeline)
    expect(second).toEqual(first)
    const { spec } = readEntity(
      new MemoryTree(Object.fromEntries(first.map((f) => [f.path, f.content]))),
      'etl-pipeline',
    )
    expect((spec as EtlPipelineSpec).status).toBe('ready')
  })
})

describe('readEntity — record lists', () => {
  it('round-trips a DQ rule set with its checks', () => {
    const ruleSet: DqRuleSetSpec = {
      ...IDENTITY, entityId: 'icu-checks',
      name: { en: 'ICU checks' },
      checks: [
        { name: 'no null person_id', sql: 'SELECT count(*) FROM person WHERE person_id IS NULL', severity: 'error' },
        { name: 'age plausible', sql: 'SELECT count(*) FROM person WHERE year_of_birth < 1900', severity: 'warning', threshold: 5 },
      ],
    }
    const { first, second } = roundTrip('dq-rule-set', ruleSet)
    expect(second).toEqual(first)
  })

  it('round-trips a mapping project with its rows', () => {
    const project: MappingProjectSpec = {
      ...IDENTITY, entityId: 'mimic-map',
      name: { en: 'MIMIC → OMOP' },
      sourceType: 'csv',
      mappings: [
        { sourceConceptCode: '220045', sourceConceptName: 'Heart Rate', targetConceptId: 3027018, status: 'approved' },
        { sourceConceptCode: '220046', sourceConceptName: 'Heart Rate Alarm', status: 'pending' },
      ],
    }
    const { first, second } = roundTrip('mapping-project', project)
    expect(second).toEqual(first)
  })

  it('round-trips a data catalog', () => {
    const catalog: DataCatalogSpec = {
      ...IDENTITY, entityId: 'icu-catalog',
      name: { en: 'ICU catalog' },
      dimensions: ['col_unit', 'col_year'],
      categoryColumn: 'col_domain',
    }
    const { first, second } = roundTrip('data-catalog', catalog)
    expect(second).toEqual(first)
  })
})

describe('readEntity — lossless carry', () => {
  it('keeps manifest fields the spec does not model, in place', () => {
    // An app-exported manifest carries organization, createdBy, license… Dropping
    // them would delete provenance on every edit, silently.
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({
        entityId: 'icu-queries',
        type: 'sql-collection',
        name: { en: 'ICU queries' },
        createdBy: 'Ada Lovelace',
        organization: { id: 'org-1', name: { en: 'InterHop' } },
        lineageId: 'abc',
        version: '2.0.0',
        license: { id: 'Apache-2.0' },
        appVersion: '2.3.3',
      }, null, 2),
      'scripts/_tree.json': JSON.stringify([
        { path: 'a.sql', type: 'file', language: 'sql', order: 0, createdAt: '' },
      ], null, 2),
      'scripts/a.sql': 'SELECT 1;\n',
    })
    const { spec } = readEntity(tree, 'sql-collection')
    expect((spec as SqlCollectionSpec & { extra?: Record<string, unknown> }).extra)
      .toMatchObject({
        createdBy: 'Ada Lovelace',
        organization: { id: 'org-1', name: { en: 'InterHop' } },
        license: { id: 'Apache-2.0' },
        appVersion: '2.3.3',
      })
  })

  it('reads a tree that still uses the retired manifest name', () => {
    // Published repos not yet re-synced carry _collection.json; refusing them
    // would make the edit tools useless on exactly the trees people have.
    const tree = new MemoryTree({
      '_collection.json': JSON.stringify({ name: { en: 'Old' } }, null, 2),
      'scripts/_tree.json': JSON.stringify([
        { path: 'a.sql', type: 'file', language: 'sql', order: 0, createdAt: '' },
      ], null, 2),
      'scripts/a.sql': 'SELECT 1;\n',
    })
    expect(readEntity(tree, 'sql-collection').spec.name).toEqual({ en: 'Old' })
  })

  it('keeps parentLineageId when it is explicitly null', () => {
    // The app always writes this key (PROVENANCE_ORDER), null when unset. A
    // truthy test drops it, and the first sync after an edit then shows a
    // deletion nobody made.
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({
        entityId: 'm', type: 'mapping-project', name: { en: 'M' },
        status: 'in_progress', parentLineageId: null, version: '0.1.0',
      }, null, 2),
      'mappings.json': '[]',
    })
    const { spec } = readEntity(tree, 'mapping-project')
    const out = serializeEntity('mapping-project' as never, spec as never)
    expect(JSON.parse(out[0].content)).toHaveProperty('parentLineageId', null)
  })

  it('keeps a mapping project past draft at the status it reached', () => {
    // It was hardcoded to 'draft', so a project at in_progress was reset by its
    // own round trip — a real edit silently undoing the user's progress.
    const tree = new MemoryTree({
      'entity.json': JSON.stringify({
        entityId: 'm', type: 'mapping-project', name: { en: 'M' }, status: 'in_progress',
      }, null, 2),
      'mappings.json': '[]',
    })
    const { spec } = readEntity(tree, 'mapping-project')
    const out = serializeEntity('mapping-project' as never, spec as never)
    expect(JSON.parse(out[0].content).status).toBe('in_progress')
  })

  it('refuses a tree with no manifest, by saying so', () => {
    expect(() => readEntity(new MemoryTree({ 'scripts/a.sql': '' }), 'sql-collection'))
      .toThrow(/No entity\.json/)
  })
})
