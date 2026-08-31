import { describe, it, expect } from 'vitest'
import { buildSeedManifest, buildSeedProjectIndex, buildSeedRoot } from './seed-manifest.js'
import { MemoryTree } from './tree.js'

/** A workspace tree as the fetch script assembles it: pointers already spliced. */
function workspace(files: Record<string, string>): MemoryTree {
  return new MemoryTree({ 'entity.json': '{"type":"workspace"}', ...files })
}

describe('buildSeedManifest — entities', () => {
  it('indexes a project by its folder name', () => {
    const m = buildSeedManifest(workspace({ 'projects/icu-demo/entity.json': '{}' }))
    expect(m.entities).toEqual([{ type: 'project', id: 'icu-demo', folder: 'icu-demo' }])
    expect(m.schemaVersion).toBe(2)
  })

  it('skips a folder with no manifest — it is not an entity', () => {
    const m = buildSeedManifest(workspace({ 'projects/stray/README.md': '# hi' }))
    expect(m.entities).toEqual([])
  })

  // A repo published before the rename must keep indexing: both names resolve.
  it('accepts a retired manifest name', () => {
    const m = buildSeedManifest(workspace({ 'projects/old/project.json': '{}' }))
    expect(m.entities).toHaveLength(1)
    const mp = buildSeedManifest(workspace({ 'mapping-projects/mimic/_project.json': '{}' }))
    expect(mp.entities[0]).toMatchObject({ type: 'mappingProject', id: 'mimic' })
  })

  it('reads both the folder and the flat pre-folder form of a rule set', () => {
    const m = buildSeedManifest(workspace({
      'data-quality/legacy.json': '{}',
      'data-quality/modern/entity.json': '{}',
    }))
    expect(m.entities).toEqual([
      { type: 'dqRuleSet', id: 'legacy', path: 'data-quality/legacy.json' },
      { type: 'dqRuleSet', id: 'modern', path: 'data-quality/modern/entity.json' },
    ])
  })

  // Declaration order is replayed by the loader and feeds the seed hashes, so a
  // manifest that reshuffled per build would announce phantom "data updates".
  it('orders folders deterministically', () => {
    const files = { b: '{}', a: '{}', c: '{}' }
    const tree = workspace(Object.fromEntries(
      Object.keys(files).map((n) => [`projects/${n}/entity.json`, '{}']),
    ))
    expect(buildSeedManifest(tree).entities.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('buildSeedManifest — databases', () => {
  const manifest = JSON.stringify({
    entityId: 'mimic-iv-demo',
    alias: 'mimic_iv',
    name: { en: 'MIMIC-IV Demo' },
    schemaMapping: { tables: {} },
  })
  const withData = {
    'databases/mimic-iv-demo/entity.json': manifest,
    'databases/mimic-iv-demo/data/person.parquet': 'PAR1',
    'databases/mimic-iv-demo/data/visit_occurrence.parquet': 'PAR1',
  }

  // No rows in the repo means nothing to mount, so it stays metadata: the
  // workspace import writes the row like any other pointer.
  it('leaves a database out of entities when the repo ships no Parquet', () => {
    const m = buildSeedManifest(
      workspace({ 'databases/mimic-iv-demo/entity.json': manifest }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities).toEqual([])
    expect(m.internals?.databases).toEqual(['databases/mimic-iv-demo/entity.json'])
  })

  // Derived from the files present, never from a hand-kept list — the two cannot
  // drift, and adding a table to the repo needs no change here.
  it('derives parquetBase and tables from the repo itself', () => {
    const m = buildSeedManifest(workspace(withData), { seedBaseUrl: '/data/seed/default' })
    expect(m.entities[0]).toMatchObject({
      type: 'database',
      // Keyed on the manifest's entityId, not the folder: the workspace import
      // wrote the row under that id, and the loader has to find the same one.
      id: 'mimic-iv-demo',
      alias: 'mimic_iv',
      parquetBase: '/data/seed/default/databases/mimic-iv-demo/data',
      tables: ['person', 'visit_occurrence'],
    })
  })

  it('stays metadata-only when no base URL is given to build a fetchable path', () => {
    expect(buildSeedManifest(workspace(withData)).entities).toEqual([])
  })

  it('carries the one seed-only link a project export deliberately strips', () => {
    const m = buildSeedManifest(workspace(withData), {
      seedBaseUrl: '/data/seed/default',
      databases: { 'mimic-iv-demo': { linkToProject: 'proj-1' } },
    })
    expect(m.entities[0]).toMatchObject({ linkToProject: 'proj-1' })
  })

  it('keeps the vocabulary flag, which changes how the loader mounts it', () => {
    const m = buildSeedManifest(
      workspace({
        'databases/vocab/entity.json': '{"entityId":"vocab","isVocabularyReference":true}',
        'databases/vocab/data/concept.parquet': 'PAR1',
      }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities[0]).toMatchObject({ isVocabularyReference: true })
  })

  // The loader mounts against this. Reading only the inline form (which a repo
  // published since the schema split no longer has) seeded a database whose
  // every table was unreadable.
  it('takes the schema from mapping.json, where the split put it', () => {
    const m = buildSeedManifest(
      workspace({
        'databases/db/entity.json': '{"entityId":"db"}',
        'databases/db/mapping.json': '{"patientTable":"patients"}',
        'databases/db/data/patients.parquet': 'PAR1',
      }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities[0].schema).toEqual({ patientTable: 'patients' })
  })

  it('folds the DDL in beside the mapping when the repo ships one', () => {
    const m = buildSeedManifest(
      workspace({
        'databases/db/entity.json': '{"entityId":"db"}',
        'databases/db/mapping.json': '{"patientTable":"patients"}',
        'databases/db/schema.ddl': 'CREATE TABLE patients (id INT);',
        'databases/db/data/patients.parquet': 'PAR1',
      }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities[0].schema).toEqual({
      patientTable: 'patients',
      ddl: 'CREATE TABLE patients (id INT);',
    })
  })

  it('still reads the inline mapping a pre-split tree carries', () => {
    const m = buildSeedManifest(workspace(withData), { seedBaseUrl: '/data/seed/default' })
    expect(m.entities[0].schema).toEqual({ tables: {} })
  })

  // The link back to the published schema, so the database can say what it was
  // built from even where that preset is not installed.
  it('carries schemaSource through', () => {
    const m = buildSeedManifest(
      workspace({
        'databases/db/entity.json': '{"entityId":"db","schemaSource":{"lineageId":"lin-1"}}',
        'databases/db/mapping.json': '{}',
        'databases/db/data/t.parquet': 'PAR1',
      }),
      { seedBaseUrl: '/data/seed/default' },
    )
    expect(m.entities[0].schemaSource).toEqual({ lineageId: 'lin-1' })
  })
})

describe('buildSeedProjectIndex', () => {
  // The loader fetches over HTTP and cannot list a directory: anything absent
  // from this index is never read. That is why a project seeded from the
  // published workspace arrived with no dashboard, no scripts, an empty dataset.
  it('lists the scripts beside their tree', () => {
    const tree = new MemoryTree({
      'projects/p/scripts/_tree.json': '[]',
      'projects/p/scripts/01_extract.sql': 'SELECT 1',
      'projects/p/scripts/02_build.py': 'x = 1',
    })
    expect(buildSeedProjectIndex(tree, 'projects/p').scripts)
      .toEqual(['01_extract.sql', '02_build.py'])
  })

  // Without the tree the loader has no rows to attach contents to, so listing
  // the files alone would be meaningless.
  it('omits scripts when the tree itself is missing', () => {
    const tree = new MemoryTree({ 'projects/p/scripts/01.sql': 'SELECT 1' })
    expect(buildSeedProjectIndex(tree, 'projects/p').scripts).toBeUndefined()
  })

  it('lists dashboards, cohorts, pipelines and connections', () => {
    const tree = new MemoryTree({
      'projects/p/dashboards/icu.json': '{}',
      'projects/p/cohorts/adults.json': '{}',
      'projects/p/pipeline/pipeline.json': '[]',
      'projects/p/databases/conn.json': '{}',
    })
    expect(buildSeedProjectIndex(tree, 'projects/p')).toMatchObject({
      dashboards: ['icu.json'],
      cohorts: ['adults.json'],
      pipelines: ['pipeline.json'],
      connections: ['conn.json'],
    })
  })

  // `patient-dashboards/` is its own folder, not a `dashboards/` subfolder: left
  // out of the index, a seeded project showed no patient board at all.
  it('lists patient dashboards apart from dashboards', () => {
    const tree = new MemoryTree({
      'projects/p/dashboards/icu.json': '{}',
      'projects/p/patient-dashboards/board.json': '{}',
    })
    expect(buildSeedProjectIndex(tree, 'projects/p')).toMatchObject({
      dashboards: ['icu.json'],
      patientDashboards: ['board.json'],
    })
  })

  it('separates a CSV the loader parses from a raw upload it restores verbatim', () => {
    const tree = new MemoryTree({
      'projects/p/datasets/_tree.json': '[]',
      'projects/p/datasets/activity/activity.csv': 'a,b',
      'projects/p/datasets/activity/_columns.json': '[]',
      'projects/p/datasets/cohort/cohort.xlsx': 'PK',
    })
    const index = buildSeedProjectIndex(tree, 'projects/p')
    expect(index.datasetFolders).toEqual(['activity', 'cohort'])
    expect(index.datasetCsvFiles).toEqual({ activity: 'activity.csv' })
    expect(index.datasetRawFiles).toEqual({ cohort: 'cohort.xlsx' })
  })

  it('reports a parsed-rows sidecar, which the loader prefers over the CSV', () => {
    const tree = new MemoryTree({
      'projects/p/datasets/_tree.json': '[]',
      'projects/p/datasets/activity/_data.json': '{"rows":[]}',
      'projects/p/datasets/activity/activity.csv': 'a,b',
    })
    expect(buildSeedProjectIndex(tree, 'projects/p').datasetDataSidecars).toEqual(['activity'])
  })

  // `_columns.json` and `_data.json` are metadata, not analyses — indexing them
  // as analyses would have the loader write junk rows.
  it('counts only real analyses, never the sidecars', () => {
    const tree = new MemoryTree({
      'projects/p/datasets/_tree.json': '[]',
      'projects/p/datasets/activity/_columns.json': '[]',
      'projects/p/datasets/activity/_data.json': '{}',
      'projects/p/datasets/activity/survival.json': '{}',
    })
    expect(buildSeedProjectIndex(tree, 'projects/p').datasetAnalyses)
      .toEqual({ activity: ['survival.json'] })
  })

  it('is empty for a project that ships only metadata', () => {
    const tree = new MemoryTree({ 'projects/p/entity.json': '{}', 'projects/p/README.md': '# hi' })
    expect(buildSeedProjectIndex(tree, 'projects/p')).toEqual({})
  })
})

describe('buildSeedManifest — internals', () => {
  it('lists a pipeline and its script files, minus the manifest', () => {
    const m = buildSeedManifest(workspace({
      'etl/mimic/entity.json': '{}',
      'etl/mimic/_tree.json': '[]',
      'etl/mimic/scripts/01_load.sql': 'select 1',
    }))
    expect(m.internals?.etlPipelines).toEqual(['mimic'])
    expect(m.internals?.etlFiles).toEqual({ 'mimic/scripts/01_load.sql': 'scripts/01_load.sql' })
  })

  it('keeps a plugin\'s own functional manifest in its file list', () => {
    const m = buildSeedManifest(workspace({
      'plugins/chart/entity.json': '{}',
      'plugins/chart/plugin.json': '{}',
      'plugins/chart/index.js': 'export {}',
    }))
    expect(m.internals?.pluginFolders).toEqual(['chart'])
    // entity.json is Linkr metadata and drops out; plugin.json is content.
    expect(m.internals?.pluginFiles?.chart).toEqual(['index.js', 'plugin.json'])
  })

  it('ignores wiki pages with no tree index', () => {
    const withoutTree = buildSeedManifest(workspace({ 'wiki/home.md': '# home' }))
    expect(withoutTree.internals?.wikiPages).toBeUndefined()
    const withTree = buildSeedManifest(workspace({
      'wiki/_tree.json': '[]',
      'wiki/home.md': '# home',
    }))
    expect(withTree.internals?.wikiPages).toEqual(['wiki/home.md'])
  })

  it('omits internals entirely when there are none', () => {
    const m = buildSeedManifest(workspace({ 'projects/p/entity.json': '{}' }))
    expect(m.internals).toBeUndefined()
  })

  it('stamps the organization only when given one', () => {
    expect(buildSeedManifest(workspace({})).organization).toBeUndefined()
    const org = { id: 'org-1', name: 'Demo' }
    expect(buildSeedManifest(workspace({}), { organization: org }).organization).toEqual(org)
  })
})

describe('buildSeedRoot', () => {
  it('sorts the workspace list so the file is stable across builds', () => {
    expect(buildSeedRoot(['b', 'a'])).toEqual({ schemaVersion: 2, workspaces: ['a', 'b'] })
  })
})
