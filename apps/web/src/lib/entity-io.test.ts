import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { slugify, parseCsvLine, parseCsvToDatasetData, parseProjectZip, parseWorkspaceZip, deleteProjectData, datasetToCsv, importProjectContent, stripInstanceFields, dropForeignAuthorId, attachEntityOrganization, buildWorkspaceZip, buildUserPluginZip, buildEtlPipelineFolder, buildDataSourceFolder, collectGitLinkedEntities, applyClonedEntity, parseDatabaseZip, importParsedDatabase, gitignoreEscapePath, excludedCodeFiles, reconstructTreeFiles, readImportedManifest, readImportedTree, reassemblePresetMapping, canonicalSchemaMapping, projectSlug, sameProjectSlug } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import { deterministicId } from '@/lib/deterministic-id'
import { isVersioned } from '@/features/warehouse/etl/etl-versioning'
import type { DatasetFile, DataCatalog, DqRuleSet, DqCustomCheck, CustomSchemaPreset } from '@/types'
import type { Storage } from '@/lib/storage'

const serverMode = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => serverMode.value }))
const importDatasetOnServer = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer }))

// slugify produces filesystem-safe names for ZIP entries and folders.
// A bad slug means a file overwrites another or fails to write → data loss.
// Instance-specific fields must not land in an exported project.json/workspace.json,
// or a round-trip export→import→export drifts (owner/workspace/git differ per instance)
// and the repo's own git remote (with a possible token) would be committed into itself.
describe('stripInstanceFields', () => {
  it('drops owner, local author id, placement, git link, catalog/org and updatedAt, but KEEPS createdAt', () => {
    const meta = {
      uid: 'p1', name: { en: 'P' }, config: {},
      ownerId: 7, createdById: 3, workspaceId: 'ws-1',
      gitRemoteConfig: { url: 'https://x/y.git', branch: 'main', authToken: 'secret' },
      gitUrl: 'https://x/y.git', catalogVisibility: 'public',
      organization: { id: 'o' }, organizationId: 'o',
      createdAt: '2020', updatedAt: '2021',
    }
    const out = stripInstanceFields(meta)
    // createdAt is stable provenance and survives; updatedAt churns and is dropped.
    expect(out).toEqual({ uid: 'p1', name: { en: 'P' }, config: {}, createdAt: '2020' })
    expect('updatedAt' in out).toBe(false)
    // notably the token is gone
    expect(JSON.stringify(out)).not.toContain('secret')
  })

  // The original author's display snapshot must SURVIVE an export so the importer
  // isn't credited as the creator; only the (instance-local) createdById is dropped.
  it('preserves the original-author snapshot but drops the local author id', () => {
    const meta = {
      uid: 'p1', name: { en: 'P' },
      createdById: 42,
      createdBy: 'Jane Doe',
      createdByDetails: { firstName: 'Jane', lastName: 'Doe', orcid: '0000-0001-2345-6789' },
    }
    const out = stripInstanceFields(meta)
    expect(out).toEqual({
      uid: 'p1', name: { en: 'P' },
      createdBy: 'Jane Doe',
      createdByDetails: { firstName: 'Jane', lastName: 'Doe', orcid: '0000-0001-2345-6789' },
    })
    expect('createdById' in out).toBe(false)
  })

  it('leaves portable content untouched', () => {
    // version is a portable user-facing field — kept, like status/badges.
    const meta = { uid: 'p1', name: { en: 'P' }, description: { en: 'D' }, badges: [{ id: 'b' }], status: 'active', version: '1.2.0' }
    expect(stripInstanceFields(meta)).toEqual(meta)
  })

  // lineageId is the cross-instance identity — it MUST survive export (the local
  // PK uid is what gets regenerated on import, not the lineage).
  it('preserves lineageId and parentLineageId', () => {
    const meta = { uid: 'p1', name: { en: 'P' }, lineageId: 'lin-1', parentLineageId: 'lin-0' }
    const out = stripInstanceFields(meta)
    expect(out.lineageId).toBe('lin-1')
    expect(out.parentLineageId).toBe('lin-0')
  })
})

// On import, a createdById from the exporting instance is a foreign local user id
// and must never be persisted verbatim — the snapshot is what identifies the author.
describe('dropForeignAuthorId', () => {
  it('clears createdById while keeping the author snapshot', () => {
    const rec = { id: 'x', createdById: 7, createdBy: 'Jane', createdByDetails: { orcid: 'o' } }
    expect(dropForeignAuthorId(rec)).toEqual({ id: 'x', createdById: undefined, createdBy: 'Jane', createdByDetails: { orcid: 'o' } })
  })

  it('is a no-op for records without createdById', () => {
    const rec = { id: 'x', name: 'n' }
    expect(dropForeignAuthorId(rec)).toBe(rec)
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('My Project')).toBe('my-project')
  })

  it('strips accents (NFD)', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme')
  })

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(slugify('a___b!!!c')).toBe('a-b-c')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello')
    expect(slugify('--edge--')).toBe('edge')
  })

  it('falls back to "export" when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('export')
    expect(slugify('')).toBe('export')
  })

  it('keeps digits', () => {
    expect(slugify('Cohort 2024')).toBe('cohort-2024')
  })
})

// Byte-parity with the Python _gitignore_escape (test_project_export.py). A marked
// filename with a gitignore metachar must escape so the !path exception matches the
// literal file rather than being read as a pattern.
describe('gitignoreEscapePath', () => {
  it('escapes glob metacharacters and prefixes', () => {
    expect(gitignoreEscapePath('scripts/a[1]*.csv')).toBe('scripts/a\\[1\\]\\*.csv')
    expect(gitignoreEscapePath('#weird!.csv')).toBe('\\#weird\\!.csv')
    expect(gitignoreEscapePath('q?.csv')).toBe('q\\?.csv')
    expect(gitignoreEscapePath('a\\b.csv')).toBe('a\\\\b.csv')
  })

  it('escapes trailing spaces so git does not strip them', () => {
    expect(gitignoreEscapePath('name .csv ')).toBe('name .csv\\ ')
  })

  it('leaves a plain path unchanged', () => {
    expect(gitignoreEscapePath('datasets/cohort/cohort.csv')).toBe('datasets/cohort/cohort.csv')
  })
})

describe('excludedCodeFiles', () => {
  it('reads the string list from project.config.excludedFiles', () => {
    const s = excludedCodeFiles({ config: { excludedFiles: ['scripts/a.py', 'scripts/b.sql', 42] } })
    expect(s).toEqual(new Set(['scripts/a.py', 'scripts/b.sql']))
  })

  it('returns an empty set when absent or malformed', () => {
    expect(excludedCodeFiles(null).size).toBe(0)
    expect(excludedCodeFiles({ config: {} }).size).toBe(0)
    expect(excludedCodeFiles({ config: { excludedFiles: 'nope' } }).size).toBe(0)
  })
})

// The git-link project pointer must match the Python builder byte-for-byte: an
// absent createdAt is OMITTED (JSON.stringify drops undefined) — emitting a null
// like Python's json.dumps would would spuriously diverge on a mixed-mode remote.
describe('buildWorkspaceZip — git-link pointer createdAt', () => {
  const GIT = { url: 'https://example.test/repo.git', branch: 'main' }
  const storeWith = (project: Record<string, unknown>) => {
    const table = (methods: Record<string, unknown>) => new Proxy(methods, {
      get: (t, prop) => (typeof prop === 'string' && prop in t ? (t as Record<string, unknown>)[prop] : async () => []),
    })
    return new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'workspaces': return table({ getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {} }) })
          case 'organizations': return table({ getById: async () => undefined })
          case 'projects': return table({ getAll: async () => [project] })
          default: return table({})
        }
      },
    }) as unknown as Storage
  }
  const pointer = async (project: Record<string, unknown>) => {
    const ONLY = { projects: true } as unknown as NonNullable<Parameters<typeof buildWorkspaceZip>[2]>['sections']
    const built = await buildWorkspaceZip('w1', storeWith(project), { sections: ONLY })
    const zip = await JSZip.loadAsync(await built!.blob.arrayBuffer())
    return JSON.parse(await zip.files['projects/p/entity.json'].async('string')) as Record<string, unknown>
  }

  it('omits createdAt when absent, preserving key order', async () => {
    const ptr = await pointer({ uid: 'u1', projectId: 'p', name: { en: 'P' }, workspaceId: 'w1', gitRemoteConfig: GIT })
    expect('createdAt' in ptr).toBe(false)
    expect(Object.keys(ptr)).toEqual(['uid', 'entityId', 'type', 'name', 'lineageId', 'gitRemoteConfig'])
  })

  it('keeps createdAt when present', async () => {
    const ptr = await pointer({ uid: 'u1', projectId: 'p', name: { en: 'P' }, workspaceId: 'w1', createdAt: '2026-01-01T00:00:00.000Z', gitRemoteConfig: GIT })
    expect(ptr.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(Object.keys(ptr)).toEqual(['uid', 'entityId', 'type', 'name', 'createdAt', 'lineageId', 'gitRemoteConfig'])
  })
})

// Step 2 of the export-format harmonization: every reader accepts the shared
// `entity.json` as well as the historical per-kind manifest name, so a tree in
// either format imports. Writers still emit the old names — that is step 3.
describe('entity.json — the app reads either manifest name', () => {
  const inertStore = (capture: unknown[], table: string) => new Proxy({}, {
    get: (_t, prop) => prop === table
      ? {
          save: (v: unknown) => { capture.push(v); return Promise.resolve() },
          create: (v: unknown) => { capture.push(v); return Promise.resolve() },
          update: (_id: string, v: unknown) => { capture.push(v); return Promise.resolve() },
          getById: async () => undefined,
        }
      : new Proxy({}, { get: () => async () => [] }),
  }) as unknown as Storage

  it('clones a schema preset published as entity.json', async () => {
    const saves: unknown[] = []
    const zip = new JSZip()
    zip.file('entity.json', JSON.stringify({
      type: 'schema-preset', entityId: 'omop', lineageId: 'lin-1',
      mapping: { presetId: 'omop', presetLabel: { en: 'OMOP' } },
    }))
    zip.file('schema.ddl', 'CREATE TABLE person ();')
    expect(await applyClonedEntity(zip, 'schema-preset', 'preset-target', inertStore(saves, 'schemaPresets'))).toBe(true)
    const saved = saves[0] as { entityId?: string; lineageId?: string; mapping?: { ddl?: string; presetId?: string } }
    // The repo's own entityId is kept (it is the published slug); the LOCAL key
    // follows the target, and the DDL is folded back out of its sibling file.
    expect(saved.entityId).toBe('omop')
    expect(saved.mapping?.presetId).toBe('preset-target')
    expect(saved.lineageId).toBe('lin-1')
    expect(saved.mapping?.ddl).toBe('CREATE TABLE person ();')
  })

  it('clones a data catalog published as entity.json', async () => {
    const saves: unknown[] = []
    const zip = new JSZip()
    zip.file('entity.json', JSON.stringify({
      type: 'data-catalog', id: 'cat-1', name: { en: 'Catalog' }, dimensions: [],
    }))
    expect(await applyClonedEntity(zip, 'data-catalog', 'cat-target', inertStore(saves, 'dataCatalogs'))).toBe(true)
    expect(saves.length).toBeGreaterThan(0)
  })

  it('prefers entity.json when a tree carries both names', async () => {
    const saves: unknown[] = []
    const zip = new JSZip()
    zip.file('entity.json', JSON.stringify({ type: 'data-catalog', id: 'c', name: { en: 'New' }, dimensions: [] }))
    zip.file('catalog.json', JSON.stringify({ id: 'c', name: { en: 'Old' }, dimensions: [] }))
    await applyClonedEntity(zip, 'data-catalog', 'cat-target', inertStore(saves, 'dataCatalogs'))
    expect(JSON.stringify(saves[0])).toContain('New')
  })

  it('parses a workspace whose nested entities use entity.json', async () => {
    const zip = new JSZip()
    zip.file('workspace.json', JSON.stringify({ id: 'w1', name: { en: 'W' } }))
    zip.file('sql-scripts/queries/entity.json', JSON.stringify({
      type: 'sql-collection', id: 'col1', name: { en: 'Queries' },
    }))
    zip.file('sql-scripts/queries/_tree.json', JSON.stringify([
      { path: 'top.sql', type: 'file', order: 0 },
    ]))
    zip.file('sql-scripts/queries/top.sql', 'SELECT 1;')
    const parsed = await parseWorkspaceZip(
      await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File,
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.sqlCollections).toHaveLength(1)
    expect(parsed!.sqlCollections[0].collection.name).toEqual({ en: 'Queries' })
  })
})

// The workspace export must emit the same bytes as the Python twin
// (apps/api/.../workspace_export.py). These three cases each caught a real
// front/back divergence that the golden fixture could not see, because the
// sections involved were exported empty.
describe('buildWorkspaceZip — front/back parity', () => {
  const storeWith = (tables: Record<string, Record<string, unknown>>) => {
    const table = (methods: Record<string, unknown>) => new Proxy(methods, {
      get: (t, prop) => (typeof prop === 'string' && prop in t ? (t as Record<string, unknown>)[prop] : async () => []),
    })
    return new Proxy({}, {
      get: (_t, prop) => {
        if (typeof prop === 'string' && prop in tables) return table(tables[prop])
        if (prop === 'organizations') return table({ getById: async () => undefined })
        return table({})
      },
    }) as unknown as Storage
  }
  const build = async (tables: Record<string, Record<string, unknown>>, sections: Record<string, boolean>) => {
    const built = await buildWorkspaceZip('w1', storeWith(tables), {
      sections: sections as unknown as NonNullable<Parameters<typeof buildWorkspaceZip>[2]>['sections'],
    })
    return JSZip.loadAsync(await built!.blob.arrayBuffer())
  }

  // The server writes readmeLang via strip_entity_docs whenever the primary
  // README is not English; the front used to hand-roll the strip and omit it,
  // so a French-only workspace exported different bytes on each side.
  it('stamps readmeLang when the primary README is not English', async () => {
    const zip = await build({
      workspaces: { getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {}, readme: { fr: '# Bonjour\n' } }) },
    }, { projects: true })
    const ws = JSON.parse(await zip.files['entity.json'].async('string')) as Record<string, unknown>
    expect(ws.readmeLang).toBe('fr')
    expect('readme' in ws).toBe(false)
  })

  it('omits readmeLang when the primary README is English', async () => {
    const zip = await build({
      workspaces: { getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {}, readme: { en: '# Hello\n', fr: '# Bonjour\n' } }) },
    }, { projects: true })
    const ws = JSON.parse(await zip.files['entity.json'].async('string')) as Record<string, unknown>
    expect('readmeLang' in ws).toBe(false)
  })

  // localeCompare orders by the reader's locale, so the same workspace could
  // emit two different link orders — and disagree with Python's tuple sort.
  it('orders git-links by code point, not locale', async () => {
    const GIT = { url: 'https://example.test/r.git', branch: 'main' }
    const zip = await build({
      workspaces: { getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {} }) },
      dqRuleSets: { getByWorkspace: async () => [
        { id: 'b', entityId: 'b', name: { en: 'B' }, gitRemoteConfig: GIT },
        { id: 'A', entityId: 'a', name: { en: 'A' }, gitRemoteConfig: GIT },
      ] },
    }, { dataQuality: true })
    const links = (JSON.parse(await zip.files['git-links.json'].async('string')) as { links: { id: string }[] }).links
    // 'A' (0x41) sorts before 'b' (0x62) by code point; many locales invert this.
    expect(links.map(l => l.id)).toEqual(['A', 'b'])
  })

  // Parsed by parseWorkspaceZip and carried in ParsedWorkspaceZip since forever,
  // but never written — so export → reimport silently dropped every concept set.
  it('writes concept sets so they survive a round trip', async () => {
    const zip = await build({
      workspaces: { getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {} }) },
      conceptSets: { getByWorkspace: async () => [
        { id: 'cs1', workspaceId: 'w1', name: 'Sepsis criteria', description: 'd', expression: { items: [] }, resolvedConceptIds: null, updatedAt: '2026-06-01T00:00:00.000Z' },
      ] },
    }, { conceptMapping: true })
    const written = JSON.parse(await zip.files['concept-sets/sepsis-criteria.json'].async('string')) as Record<string, unknown>
    expect(written.name).toBe('Sepsis criteria')
    expect('workspaceId' in written).toBe(false)
    expect('updatedAt' in written).toBe(false)
  })
})

// parseCsvLine guards data integrity on import. Quote handling bugs silently
// corrupt clinical data, so the adversarial cases matter.
describe('parseCsvLine', () => {
  it('splits a plain line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsvLine('"a,b",c')).toEqual(['a,b', 'c'])
  })

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsvLine('"she said ""hi""",x')).toEqual(['she said "hi"', 'x'])
  })

  it('preserves empty fields', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c'])
    expect(parseCsvLine(',')).toEqual(['', ''])
  })

  it('handles a trailing empty field', () => {
    expect(parseCsvLine('a,')).toEqual(['a', ''])
  })
})

describe('parseCsvToDatasetData', () => {
  const df: DatasetFile = {
    id: 'ds1',
    projectUid: 'p1',
    name: 'labs.csv',
    type: 'file',
    parentId: null,
    columns: [
      { id: 'c_id', name: 'patient', type: 'string', order: 0 },
      { id: 'c_val', name: 'value', type: 'number', order: 1 },
    ],
    createdAt: '',
    updatedAt: '',
  }

  it('maps header names to column ids and parses numbers', () => {
    const out = parseCsvToDatasetData('patient,value\nA,3.5\nB,7', df)
    expect(out).not.toBeNull()
    expect(out!.datasetFileId).toBe('ds1')
    expect(out!.rows).toEqual([
      { c_id: 'A', c_val: 3.5 },
      { c_id: 'B', c_val: 7 },
    ])
  })

  it('keeps non-numeric values as strings', () => {
    const out = parseCsvToDatasetData('patient,value\nA,n/a', df)
    expect(out!.rows[0]).toEqual({ c_id: 'A', c_val: 'n/a' })
  })

  it('maps empty cells to null', () => {
    const out = parseCsvToDatasetData('patient,value\nA,', df)
    expect(out!.rows[0]).toEqual({ c_id: 'A', c_val: null })
  })

  it('skips fully empty rows', () => {
    const out = parseCsvToDatasetData('patient,value\nA,1\n,\nB,2', df)
    expect(out!.rows).toHaveLength(2)
  })

  it('returns null when there is only a header (no data rows)', () => {
    expect(parseCsvToDatasetData('patient,value', df)).toBeNull()
  })

  it('falls back to header name when no column mapping matches', () => {
    const out = parseCsvToDatasetData('unknown_col\nx', {
      ...df,
      columns: [],
    })
    expect(out!.rows[0]).toEqual({ unknown_col: 'x' })
  })
})

// A "data-included" project export writes a _data.json sidecar per dataset folder. parseProjectZip
// must read those as dataset ROWS, never mistake them for analysis JSONs — doing so pushed idless
// "analyses" whose ids collided on import (IndexedDB uniqueness error → datasets imported empty).
describe('parseProjectZip — dataset data sidecars', () => {
  const makeZip = async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      uid: 'p1', name: { en: 'P' }, projectId: 'p', workspaceId: 'w', ownerId: 1,
    }))
    const tree: DatasetFile[] = [
      { id: 'a', projectUid: 'p1', name: 'a.csv', type: 'file', parentId: null, columns: [{ id: 'c', name: 'v', type: 'number', order: 0 }], createdAt: '', updatedAt: '' },
      { id: 'b', projectUid: 'p1', name: 'b.csv', type: 'file', parentId: null, columns: [{ id: 'c', name: 'v', type: 'number', order: 0 }], createdAt: '', updatedAt: '' },
    ]
    zip.file('datasets/_tree.json', JSON.stringify(tree))
    for (const f of tree) {
      zip.file(`datasets/${f.name.replace(/\.[^.]+$/, '')}/_columns.json`, JSON.stringify(f.columns))
      zip.file(`datasets/${f.name.replace(/\.[^.]+$/, '')}/_data.json`, JSON.stringify({ rows: [{ c: 1 }, { c: 2 }] }))
    }
    // JSZip.loadAsync accepts an ArrayBuffer; we cast since parseProjectZip's param is typed File
    // (jsdom's Blob isn't reliably readable by JSZip in the test environment).
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('reads _data.json as rows and produces no spurious analyses', async () => {
    const parsed = await parseProjectZip(await makeZip())
    expect(parsed).not.toBeNull()
    // The two _data.json sidecars must NOT have become analyses.
    expect(parsed!.datasetAnalyses).toHaveLength(0)
    // Both datasets' rows are loaded.
    expect(parsed!.datasetData).toHaveLength(2)
    expect(parsed!.datasetData.every((d) => d.rows.length === 2)).toBe(true)
  })
})

// Managed-environment specs (environments/<lang>/<file>) must survive a clone so
// the versioned env (renv.lock / pyproject.toml) isn't dropped on import.
describe('parseProjectZip — environment specs', () => {
  const makeZip = async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'p1', name: { en: 'P' }, projectId: 'p', workspaceId: 'w', ownerId: 1 }))
    zip.file('environments/r/renv.lock', '{"Packages":{"dplyr":{"Version":"1.2.1"}}}')
    zip.file('environments/python/pyproject.toml', '[project]\nname = "p"\n')
    zip.file('environments/python/uv.lock', 'version = 1\n')
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('collects every environments/<lang>/<file> into envSpecs', async () => {
    const parsed = await parseProjectZip(await makeZip())
    expect(parsed).not.toBeNull()
    const byKey = Object.fromEntries(parsed!.envSpecs!.map((s) => [`${s.language}/${s.name}`, s.content]))
    expect(byKey['r/renv.lock']).toBe('{"Packages":{"dplyr":{"Version":"1.2.1"}}}')
    expect(byKey['python/pyproject.toml']).toContain('name = "p"')
    expect(byKey['python/uv.lock']).toBe('version = 1\n')
    expect(parsed!.envSpecs).toHaveLength(3)
  })
})

// A project inherits its org from its workspace at export time (project.json has
// no org fields, but organization.json rides alongside). Import must surface it
// so doImport can upsert the org by UUID on the target instance.
describe('parseProjectZip — organization bundle', () => {
  const ORG = {
    id: 'org-7', name: { en: 'Acme', fr: 'Acme SA' }, type: 'hospital',
    location: { en: 'Rennes', fr: 'Rennes' }, createdAt: '2020', updatedAt: '2021',
  }
  const makeZip = async (mode: 'inline' | 'sidecar' | 'none') => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      uid: 'p1', name: { en: 'P' }, ...(mode === 'inline' ? { organization: ORG } : {}),
    }))
    if (mode === 'sidecar') zip.file('organization.json', JSON.stringify(ORG))
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('reads the inlined organization and preserves its multilingual fields', async () => {
    const parsed = await parseProjectZip(await makeZip('inline'))
    expect(parsed!.organization?.id).toBe('org-7')
    expect(parsed!.organization?.name).toEqual({ en: 'Acme', fr: 'Acme SA' })
    expect(parsed!.organization?.location).toEqual({ en: 'Rennes', fr: 'Rennes' })
    // The snapshot is also kept on the project record itself (immutable provenance).
    expect(parsed!.project.organization?.id).toBe('org-7')
  })

  it('still honors a legacy sidecar organization.json', async () => {
    const parsed = await parseProjectZip(await makeZip('sidecar'))
    expect(parsed!.organization?.id).toBe('org-7')
    expect(parsed!.project.organization?.id).toBe('org-7')
  })

  it('leaves organization undefined when the ZIP has none', async () => {
    const parsed = await parseProjectZip(await makeZip('none'))
    expect(parsed!.organization).toBeUndefined()
    expect(parsed!.project.organization).toBeUndefined()
  })
})

// The inline org snapshot keeps stable provenance (id + createdAt) but must drop
// updatedAt, which the importer re-stamps and which would otherwise churn the diff.
describe('attachEntityOrganization — org snapshot timestamps', () => {
  it('keeps id, normalizes createdAt to ms+Z, drops updatedAt from the attached org', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'p1', name: { en: 'P' } }))
    const entity = {
      organization: {
        id: 'org-7', name: { en: 'Acme' },
        // Second-precision (as the backend stores it) → normalized to ms+Z so the
        // inline org matches every other timestamp in the export (no diff churn).
        createdAt: '2020-01-01T00:00:00Z', updatedAt: '2021-02-02T00:00:00Z',
      },
    }
    // storage is unused when entity.organization is present.
    await attachEntityOrganization(zip, 'project.json', entity, {} as never)
    const written = JSON.parse(await zip.file('project.json')!.async('string'))
    expect(written.organization.id).toBe('org-7')
    expect(written.organization.createdAt).toBe('2020-01-01T00:00:00.000Z')
    expect('updatedAt' in written.organization).toBe(false)
  })
})

// A legacy export stripped createdAt from project.json (now kept), and updatedAt is
// still always stripped, so a ZIP may arrive WITHOUT either. Parsing must tolerate
// that — doImport falls back to now(). Regression: an unguarded
// project.createdAt.split('T') in projectToItem crashed the whole import
// ("can't access property split, createdAt is undefined").
describe('parseProjectZip — project.json without timestamps', () => {
  it('parses a stripped project.json (no createdAt/updatedAt) without throwing', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      uid: 'p1', name: { en: 'NeoCLIP' }, description: {}, projectId: 'neoclip',
      lineageId: 'lin-1',
    }))
    const parsed = await parseProjectZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed).not.toBeNull()
    expect(parsed!.project.createdAt).toBeUndefined()
    expect(parsed!.project.updatedAt).toBeUndefined()
  })

  // A clean git export drops `uid` and often has no lineage yet (lineageId: null).
  // Its only identifier is the stable `projectId` — the parse guard must accept it,
  // else a valid bundle (e.g. the NeoCLIP repo) is rejected as "not a project".
  it('parses a project identified only by projectId (no uid, null lineageId)', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      projectId: 'neoclip', name: { en: 'NeoCLIP' }, description: {},
      lineageId: null, parentLineageId: null,
    }))
    const parsed = await parseProjectZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed).not.toBeNull()
    expect(parsed!.project.projectId).toBe('neoclip')
  })
})

// A workspace's linked organization travels in organization.json (by UUID) so an
// import can reconstitute it on an instance that has never seen that org. Both the
// pointer (workspace.organizationId) and the full record must survive parsing.
describe('parseWorkspaceZip — organization bundle', () => {
  const makeZip = async (withOrg: boolean) => {
    const zip = new JSZip()
    zip.file('workspace.json', JSON.stringify({
      id: 'w1', name: { en: 'W' }, description: {},
      ...(withOrg ? { organizationId: 'org-123' } : {}),
    }))
    if (withOrg) {
      zip.file('organization.json', JSON.stringify({
        id: 'org-123', name: { en: 'Acme Hospital' }, type: 'hospital',
        referenceId: 'https://ror.org/xxxx', createdAt: '2020', updatedAt: '2021',
      }))
    }
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('reads organization.json and keeps the workspace pointer', async () => {
    const parsed = await parseWorkspaceZip(await makeZip(true))
    expect(parsed).not.toBeNull()
    expect(parsed!.workspace.organizationId).toBe('org-123')
    expect(parsed!.organization?.id).toBe('org-123')
    expect(parsed!.organization?.referenceId).toBe('https://ror.org/xxxx')
  })

  it('leaves organization undefined when the ZIP has none', async () => {
    const parsed = await parseWorkspaceZip(await makeZip(false))
    expect(parsed).not.toBeNull()
    expect(parsed!.organization).toBeUndefined()
    expect(parsed!.workspace.organizationId).toBeUndefined()
  })
})

describe('parseWorkspaceZip — dq rule set shapes', () => {
  const zipWith = async (path: string, body: unknown) => {
    const zip = new JSZip()
    zip.file('entity.json', JSON.stringify({ name: { en: 'W' }, type: 'workspace' }))
    zip.file(path, JSON.stringify(body))
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('reads a flat git pointer, the shape every linked kind now writes', async () => {
    const parsed = await parseWorkspaceZip(await zipWith('data-quality/linked/entity.json', {
      entityId: 'linked', type: 'dq-rule-set', name: { en: 'Linked' },
      lineageId: 'lin-dq', gitRemoteConfig: { url: 'https://git.example.org/dq.git', branch: 'main' },
    }))
    expect(parsed!.dqRuleSets).toHaveLength(1)
    const [entry] = parsed!.dqRuleSets
    expect(entry.ruleSet.entityId).toBe('linked')
    // The lineage must survive the read: it is what a re-import matches on, so
    // losing it here would turn every round trip into a duplicate rule set.
    expect(entry.ruleSet.lineageId).toBe('lin-dq')
    expect(entry.checks).toEqual([])
  })

  it('still reads the { ruleSet, checks } bundle an unlinked rule set writes', async () => {
    const parsed = await parseWorkspaceZip(await zipWith('data-quality/local.json', {
      ruleSet: { entityId: 'local', name: { en: 'Local' } },
      checks: [{ id: 'c1', ruleSetId: 'rs-1' }],
    }))
    expect(parsed!.dqRuleSets).toHaveLength(1)
    expect(parsed!.dqRuleSets[0].ruleSet.entityId).toBe('local')
    expect(parsed!.dqRuleSets[0].checks).toHaveLength(1)
  })
})

// A standalone entity (SQL collection, ETL, mapping project…) has no org link of
// its own — it inherits the org managed at its parent workspace. Export must resolve
// workspaceId → workspace.organizationId → the org, then inline it as an
// `organization` field on the entity's own metadata JSON (single-entity export:
// one org, embedded for a self-sufficient, human-readable file).
describe('attachEntityOrganization — inlines inherited org into entity meta', () => {
  const makeStore = (workspace: unknown, org: unknown) => ({
    workspaces: { getById: async (id: string) => ((workspace as { id?: string })?.id === id ? workspace : undefined) },
    organizations: { getById: async (id: string) => ((org as { id?: string })?.id === id ? org : undefined) },
    readmeAttachments: { getByOwner: async () => [] },
  }) as unknown as Storage

  const zipWithMeta = (meta: object) => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify(meta))
    return zip
  }

  it('inlines the resolved org onto the meta JSON', async () => {
    const zip = zipWithMeta({ uid: 'p1', name: { en: 'P' } })
    const store = makeStore(
      { id: 'w1', organizationId: 'org-9' },
      { id: 'org-9', name: { en: 'Acme', fr: 'Acme SA' } },
    )
    await attachEntityOrganization(zip, 'project.json', { workspaceId: 'w1' }, store)
    const meta = JSON.parse(await zip.files['project.json'].async('string'))
    expect(meta.organization.id).toBe('org-9')
    expect(meta.organization.name).toEqual({ en: 'Acme', fr: 'Acme SA' })
    // No separate sidecar is written.
    expect(zip.files['organization.json']).toBeUndefined()
  })

  it('leaves the meta untouched when the entity has no workspace', async () => {
    const zip = zipWithMeta({ uid: 'p1' })
    await attachEntityOrganization(zip, 'project.json', {}, makeStore(undefined, undefined))
    const meta = JSON.parse(await zip.files['project.json'].async('string'))
    expect(meta.organization).toBeUndefined()
  })

  it('leaves the meta untouched when the workspace has no organization', async () => {
    const zip = zipWithMeta({ uid: 'p1' })
    const store = makeStore({ id: 'w1' }, undefined)
    await attachEntityOrganization(zip, 'project.json', { workspaceId: 'w1' }, store)
    const meta = JSON.parse(await zip.files['project.json'].async('string'))
    expect(meta.organization).toBeUndefined()
  })

  it('prefers the entity own snapshot over the workspace org (re-export keeps origin)', async () => {
    const zip = zipWithMeta({ uid: 'p1' })
    // Workspace here has a DIFFERENT org; the imported entity's frozen snapshot must win.
    const store = makeStore({ id: 'w1', organizationId: 'ws-org' }, { id: 'ws-org', name: { en: 'Host' } })
    const snapshot = { id: 'origin-org', name: { en: 'Origin', fr: 'Origine' } }
    await attachEntityOrganization(zip, 'project.json', { workspaceId: 'w1', organization: snapshot }, store)
    const meta = JSON.parse(await zip.files['project.json'].async('string'))
    expect(meta.organization).toEqual(snapshot)
  })
})

describe('buildUserPluginZip — author + org provenance', () => {
  const makeStore = (plugin: unknown, workspace: unknown, org: unknown) => ({
    userPlugins: { getById: async (id: string) => ((plugin as { id?: string })?.id === id ? plugin : undefined) },
    workspaces: { getById: async (id: string) => ((workspace as { id?: string })?.id === id ? workspace : undefined) },
    organizations: { getById: async (id: string) => ((org as { id?: string })?.id === id ? org : undefined) },
    readmeAttachments: { getByOwner: async () => [] },
  }) as unknown as Storage

  const readMeta = async (blob: Blob) => {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    return JSON.parse(await zip.files['entity.json'].async('string'))
  }

  it('writes createdBy + full createdByDetails but never the local createdById', async () => {
    const plugin = {
      id: 'p1', entityId: 'my-plugin', workspaceId: 'w1',
      files: { 'plugin.json': '{"id":"my-plugin"}', 'analysis.py.template': 'print(1)' },
      createdById: 42, createdBy: 'Ada Lovelace',
      createdByDetails: { firstName: 'Ada', lastName: 'Lovelace', affiliation: 'Analytical Engine', profession: 'Mathematician', orcid: '0000-0001-2345-6789' },
      createdAt: 't', updatedAt: 't',
    }
    const result = await buildUserPluginZip('p1', makeStore(plugin, { id: 'w1' }, undefined))
    const meta = await readMeta(result!.blob)
    expect(meta.createdBy).toBe('Ada Lovelace')
    expect(meta.createdByDetails.affiliation).toBe('Analytical Engine')
    expect(meta.createdByDetails.orcid).toBe('0000-0001-2345-6789')
    expect(meta.createdById).toBeUndefined()
  })

  it('inlines the full origin organization resolved from the parent workspace', async () => {
    const plugin = { id: 'p1', entityId: 'my-plugin', workspaceId: 'w1', files: { 'plugin.json': '{}' }, createdAt: 't', updatedAt: 't' }
    const org = { id: 'org-9', name: { en: 'Acme', fr: 'Acme SA' }, type: 'company', country: { en: 'France' }, referenceId: 'ROR-123' }
    const result = await buildUserPluginZip('p1', makeStore(plugin, { id: 'w1', organizationId: 'org-9' }, org))
    const meta = await readMeta(result!.blob)
    expect(meta.organization).toEqual(org)
  })
})

// Pre-import cleanup runs against a project uid that may not exist on the backend yet.
// In server mode those sub-entity routes reject with 404 ("Project not found"); the
// cleanup must swallow that instead of aborting the whole import.
describe('deleteProjectData — tolerates a missing project (server 404)', () => {
  it('does not throw when reads and deletes reject', async () => {
    const reject = () => Promise.reject(new Error('{"detail":"Project not found"}'))
    const store = new Proxy({}, {
      get: () => new Proxy({}, { get: () => reject }),
    }) as unknown as Storage

    await expect(deleteProjectData(store, 'ghost-uid')).resolves.toBeUndefined()
  })
})

// datasetToCsv keys rows by column id but must emit a NAME header, so a re-parse
// (server import) recovers the real columns. A wrong header breaks every downstream query.
describe('datasetToCsv', () => {
  const df = {
    id: 'd1', name: 'x.csv', type: 'file', parentId: null,
    columns: [
      { id: 'c0', name: 'patient_id', type: 'number', order: 0 },
      { id: 'c1', name: 'note', type: 'string', order: 1 },
    ],
  } as unknown as DatasetFile

  it('uses column names in the header and values keyed by column id', () => {
    const csv = datasetToCsv(df, [{ c0: 1, c1: 'a' }, { c0: 2, c1: 'b' }])
    expect(csv.split('\n')).toEqual(['patient_id,note', '1,a', '2,b'])
  })

  it('escapes commas, quotes and newlines; blanks nulls', () => {
    const csv = datasetToCsv(df, [{ c0: null, c1: 'a,"b"\nc' }])
    // null → empty; the second value is quoted with doubled inner quotes.
    expect(csv).toBe('patient_id,note\n,"a,""b""\nc"')
  })
})

// The reported bug: importing a project in server mode created the project + dashboards but
// NOT the datasets (the server-mode adapters no-op for dataset files), and widgets kept
// pointing at the ZIP's dataset UUID. Datasets must be uploaded via importDatasetOnServer and
// widget datasetFileId relinked to the server's path-based id.
describe('importProjectContent — server-mode datasets', () => {
  const emptyParsed = (over: Partial<ParsedProjectZip>): ParsedProjectZip => ({
    project: { uid: 'p1', name: { en: 'P' } } as unknown as ParsedProjectZip['project'],
    ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
    dashboards: [], dashboardTabs: [], dashboardWidgets: [],
    datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
    attachmentsMeta: [], attachmentBlobs: new Map(), ...over,
  })

  const makeStore = () => {
    const widgetCreate = vi.fn(async (_w: { datasetFileId?: string; source?: unknown }) => {})
    const datasetFileCreate = vi.fn(async (_f: unknown) => {})
    const dashboardCreate = vi.fn(async (_d: unknown) => {})
    const store = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'dashboardWidgets') return { create: widgetCreate }
        if (prop === 'datasetFiles') return { create: datasetFileCreate }
        if (prop === 'dashboards') return { create: dashboardCreate }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
    return { store, widgetCreate, datasetFileCreate, dashboardCreate }
  }

  beforeEach(() => {
    serverMode.value = false
    importDatasetOnServer.mockReset()
  })

  it('uploads dataset files, relinks widget datasetFileId and remaps plugin column ids', async () => {
    serverMode.value = true
    // Server re-parses the CSV → same names/order, fresh column ids.
    importDatasetOnServer.mockResolvedValue({
      id: 'table.csv',
      columns: [{ id: 'srv-0', name: 'age' }, { id: 'srv-1', name: 'sex' }],
    })

    const parsed = emptyParsed({
      datasetFiles: [{
        id: 'zip-uuid', name: 'table.csv', type: 'file', parentId: null,
        columns: [{ id: 'zip-0', name: 'age', type: 'number', order: 0 }, { id: 'zip-1', name: 'sex', type: 'string', order: 1 }],
      } as unknown as DatasetFile],
      datasetRawFiles: [{ datasetFileId: 'zip-uuid', blob: new Blob(['age,sex\n1,M']), fileName: 'table.csv' }],
      dashboardWidgets: [{
        id: 'w1', tabId: 't1', datasetFileId: 'zip-uuid',
        source: { type: 'plugin', config: { column: 'zip-0', groupColumn: 'zip-1', popupColumns: ['zip-0', 'zip-1'] } },
      } as unknown as ParsedProjectZip['dashboardWidgets'][number]],
    })

    const { store, widgetCreate, datasetFileCreate } = makeStore()
    await importProjectContent(parsed, 'p1', store)

    // The dataset file was uploaded through the real server import, not the no-op adapter.
    expect(importDatasetOnServer).toHaveBeenCalledOnce()
    expect(datasetFileCreate).not.toHaveBeenCalled()
    // The widget now points at the server's path id, not the ZIP UUID.
    const createdWidget = widgetCreate.mock.calls[0]?.[0] as { datasetFileId?: string; source?: { config?: Record<string, unknown> } }
    expect(createdWidget.datasetFileId).toBe('table.csv')
    // Plugin column ids (scalar + array) are remapped to the server's ids so the widget
    // still resolves its columns instead of showing an empty selection.
    expect(createdWidget.source?.config).toEqual({ column: 'srv-0', groupColumn: 'srv-1', popupColumns: ['srv-0', 'srv-1'] })
  })

  it('remaps a dashboard filter columnId to the server column id (by name)', async () => {
    serverMode.value = true
    importDatasetOnServer.mockResolvedValue({
      id: 'table.csv',
      columns: [{ id: 'srv-0', name: 'age' }, { id: 'srv-1', name: 'sex' }],
    })

    const parsed = emptyParsed({
      datasetFiles: [{
        id: 'zip-uuid', name: 'table.csv', type: 'file', parentId: null,
        columns: [{ id: 'zip-0', name: 'age', type: 'number', order: 0 }, { id: 'zip-1', name: 'sex', type: 'string', order: 1 }],
      } as unknown as DatasetFile],
      datasetRawFiles: [{ datasetFileId: 'zip-uuid', blob: new Blob(['age,sex\n1,M']), fileName: 'table.csv' }],
      dashboards: [{
        id: 'd1', projectUid: 'p1', name: { en: 'D' }, gridV: 2,
        filterConfig: [
          { id: 'f1', datasetFileId: 'zip-uuid', columnId: 'zip-1', columnName: 'sex', type: 'categorical', inputType: 'multi-select' },
        ],
      } as unknown as ParsedProjectZip['dashboards'][number]],
    })

    const { store, dashboardCreate } = makeStore()
    await importProjectContent(parsed, 'p1', store)

    const createdDash = dashboardCreate.mock.calls[0]?.[0] as { filterConfig?: { datasetFileId?: string; columnId?: string }[] }
    const f = createdDash.filterConfig?.[0]
    // The filter now points at the server's path + freshly-parsed column id, so it can resolve
    // its values instead of querying a column id the server no longer knows.
    expect(f?.datasetFileId).toBe('table.csv')
    expect(f?.columnId).toBe('srv-1')
  })

  it('deterministic-id export round-trips with no remap (bridge is identity)', async () => {
    serverMode.value = true
    // A fresh export carries deterministic ids; the server re-parse yields the SAME ids
    // (same names → same slugs), so the by-name bridge is identity.
    importDatasetOnServer.mockResolvedValue({
      id: 'table.csv',
      columns: [{ id: 'col_age', name: 'age' }, { id: 'col_sex', name: 'sex' }],
    })

    const parsed = emptyParsed({
      datasetFiles: [{
        id: 'table.csv', name: 'table.csv', type: 'file', parentId: null,
        columns: [{ id: 'col_age', name: 'age', type: 'number', order: 0 }, { id: 'col_sex', name: 'sex', type: 'string', order: 1 }],
      } as unknown as DatasetFile],
      datasetRawFiles: [{ datasetFileId: 'table.csv', blob: new Blob(['age,sex\n1,M']), fileName: 'table.csv' }],
      dashboards: [{
        id: 'd1', projectUid: 'p1', name: { en: 'D' }, gridV: 2,
        filterConfig: [{ id: 'f1', datasetFileId: 'table.csv', columnId: 'col_sex', columnName: 'sex', type: 'categorical', inputType: 'multi-select' }],
      } as unknown as ParsedProjectZip['dashboards'][number]],
      dashboardWidgets: [{
        id: 'w1', tabId: 't1', datasetFileId: 'table.csv',
        source: { type: 'plugin', config: { column: 'col_sex' } },
      } as unknown as ParsedProjectZip['dashboardWidgets'][number]],
    })

    const { store, dashboardCreate, widgetCreate } = makeStore()
    await importProjectContent(parsed, 'p1', store)

    const f = (dashboardCreate.mock.calls[0]?.[0] as { filterConfig?: { columnId?: string }[] }).filterConfig?.[0]
    const w = widgetCreate.mock.calls[0]?.[0] as { source?: { config?: Record<string, unknown> } }
    expect(f?.columnId).toBe('col_sex')
    expect(w.source?.config).toEqual({ column: 'col_sex' })
  })

  it('front-only mode creates the dataset file via storage (no server upload)', async () => {
    serverMode.value = false
    const parsed = emptyParsed({
      datasetFiles: [{ id: 'zip-uuid', name: 'table.csv', type: 'file', parentId: null, columns: [] } as unknown as DatasetFile],
    })
    const { store, datasetFileCreate } = makeStore()
    await importProjectContent(parsed, 'p1', store)

    expect(importDatasetOnServer).not.toHaveBeenCalled()
    expect(datasetFileCreate).toHaveBeenCalledOnce()
  })
})

// The project pull imports a curated SUBSET of the remote content: importProjectContent
describe('scripts/_tree.json — path-keyed IDE tree', () => {
  it('parses a path-keyed tree and derives ids from (projectUid, path)', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'ignored', name: { en: 'P' } }))
    zip.file('scripts/_tree.json', JSON.stringify([
      { path: 'utils', type: 'folder' },
      { path: 'utils/helpers.py', type: 'file', language: 'python' },
      { path: 'main.py', type: 'file', language: 'python' },
    ]))
    zip.file('scripts/utils/helpers.py', 'def h(): pass')
    zip.file('scripts/main.py', 'print(1)')

    const buf = await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
    const parsed = await parseProjectZip(buf)
    const nodes = parsed!.ideFiles as unknown as { path: string; type: string; content?: string }[]
    expect(nodes.map((f) => f.path)).toEqual(['utils', 'utils/helpers.py', 'main.py'])
    // Content is read from the real file at its tree path (under scripts/).
    expect(nodes.find((f) => f.path === 'utils/helpers.py')!.content).toBe('def h(): pass')

    const created: { id: string; name: string; parentId: string | null; path?: string }[] = []
    const store = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'ideFiles') return {
          create: (f: typeof created[number]) => { created.push(f); return Promise.resolve() },
          deleteByProject: async () => {},
        }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
    await importProjectContent(parsed!, 'proj-1', store, { groups: new Set(['scripts']) })

    const folder = created.find((f) => f.name === 'utils')!
    const nested = created.find((f) => f.name === 'helpers.py')!
    expect(nested.parentId).toBe(folder.id)
    expect(created.find((f) => f.name === 'main.py')!.parentId).toBeNull()
    // Ids are derived, deterministic, and the transport-only path never persists.
    expect(folder.id).toBe(deterministicId('proj-1', 'utils'))
    expect(nested.id).toBe(deterministicId('proj-1', 'utils/helpers.py'))
    expect(created.every((f) => f.path === undefined)).toBe(true)
  })

  it('still reads a legacy id/parentId scripts tree', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'ignored', name: { en: 'P' } }))
    zip.file('scripts/_tree.json', JSON.stringify([
      { id: 'f1', projectUid: 'old', name: 'utils', type: 'folder', parentId: null },
      { id: 'f2', projectUid: 'old', name: 'helpers.py', type: 'file', parentId: 'f1' },
    ]))
    zip.file('scripts/utils/helpers.py', 'legacy')
    const buf = await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
    const parsed = await parseProjectZip(buf)
    const nodes = parsed!.ideFiles as unknown as { path: string; content?: string }[]
    expect(nodes.map((f) => f.path).sort()).toEqual(['utils', 'utils/helpers.py'])
    expect(nodes.find((f) => f.path === 'utils/helpers.py')!.content).toBe('legacy')
  })
})

// with a `groups` set must write only those groups (and never the connections/databases,
// which don't travel with a project). A regression here would let a pull add entities the
// user didn't tick.
describe('importProjectContent — selective groups (project pull)', () => {
  const parsed = {
    project: { uid: 'p1', name: { en: 'P' } } as unknown as ParsedProjectZip['project'],
    // Path-keyed, like parseProjectZip emits: ids are derived at import.
    ideFiles: [{ path: 'a.sql', type: 'file', content: 'SELECT 1' } as unknown as ParsedProjectZip['ideFiles'][number]],
    pipelines: [{ id: 'pp1', name: { en: 'PL' } } as unknown as ParsedProjectZip['pipelines'][number]],
    cohorts: [{ id: 'c1', name: 'Coh', level: 'visit' } as unknown as ParsedProjectZip['cohorts'][number]],
    connections: [{ id: 'db1', name: 'DB' } as unknown as ParsedProjectZip['connections'][number]],
    conceptLists: [],
    dashboards: [{ id: 'd1', name: { en: 'Dash' } } as unknown as ParsedProjectZip['dashboards'][number]],
    dashboardTabs: [], dashboardWidgets: [],
    datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
    attachmentsMeta: [], attachmentBlobs: new Map(),
  } as ParsedProjectZip

  const makeStore = () => {
    const calls: Record<string, number> = {}
    const rec = (name: string) => vi.fn(async () => { calls[name] = (calls[name] ?? 0) + 1 })
    const creators: Record<string, () => Promise<void>> = {
      ideFiles: rec('ideFiles'), pipelines: rec('pipelines'), cohorts: rec('cohorts'),
      connections: rec('connections'), dashboards: rec('dashboards'), datasetFiles: rec('datasetFiles'),
    }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        const p = String(prop)
        if (creators[p]) return { create: creators[p] }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
    return { store, calls }
  }

  beforeEach(() => { serverMode.value = false })

  it('writes only the selected group and never connections', async () => {
    const { store, calls } = makeStore()
    await importProjectContent(parsed, 'p1', store, { groups: new Set(['dashboards']) })
    expect(calls.dashboards).toBe(1)
    expect(calls.ideFiles).toBeUndefined()
    expect(calls.cohorts).toBeUndefined()
    expect(calls.pipelines).toBeUndefined()
    expect(calls.connections).toBeUndefined()
  })

  it('writes multiple selected groups, still skipping connections', async () => {
    const { store, calls } = makeStore()
    await importProjectContent(parsed, 'p1', store, { groups: new Set(['scripts', 'cohorts']) })
    expect(calls.ideFiles).toBe(1)
    expect(calls.cohorts).toBe(1)
    expect(calls.dashboards).toBeUndefined()
    expect(calls.connections).toBeUndefined()
  })

  it('with no groups option imports everything (plain import path)', async () => {
    const { store, calls } = makeStore()
    await importProjectContent(parsed, 'p1', store)
    expect(calls.dashboards).toBe(1)
    expect(calls.ideFiles).toBe(1)
    expect(calls.cohorts).toBe(1)
    expect(calls.pipelines).toBe(1)
    expect(calls.connections).toBe(1)
  })
})

// Three "git-linkable" entity types — data-catalog, dq-rule-set, schema-preset —
// export as a metadata marker + a git-links.json pointer when linked, keep the flat
// form when unlinked, and reconstitute full content from their own cloned repo.
// A layout drift here silently breaks the linkr-portal build (it points its manifest
// at these markers) and any git-linked re-import.
describe('git-linkable catalog / dq-rule-set / schema-preset — export layout + collect + clone', () => {
  const GIT = { url: 'https://gitlab.com/g/r.git', branch: 'main' }

  const CATALOG = (over: Partial<DataCatalog> = {}): DataCatalog => ({
    id: 'cat-1', workspaceId: 'w1', entityId: 'my-catalog',
    name: { en: 'My Catalog' }, description: {}, status: 'ready',
    createdAt: '2020', updatedAt: '2021', ...over,
  } as unknown as DataCatalog)

  const RULESET = (over: Partial<DqRuleSet> = {}): DqRuleSet => ({
    id: 'rs-1', workspaceId: 'w1', entityId: 'my-ruleset',
    name: { en: 'My Rules' }, description: {}, dataSourceId: 'ds-1', status: 'idle',
    createdAt: '2020', updatedAt: '2021', ...over,
  } as unknown as DqRuleSet)

  const CHECK = (over: Partial<DqCustomCheck> = {}): DqCustomCheck => ({
    id: 'chk-1', ruleSetId: 'rs-1', name: 'not null', description: '',
    category: 'completeness', severity: 'error', threshold: 100, sql: 'SELECT 1',
    ...over,
  } as unknown as DqCustomCheck)

  const PRESET = (over: Partial<CustomSchemaPreset> = {}): CustomSchemaPreset => ({
    presetId: 'my-preset', workspaceId: 'w1',
    mapping: { presetId: 'my-preset', presetLabel: { en: 'My Preset' } },
    createdAt: '2020', updatedAt: '2021', ...over,
  } as unknown as CustomSchemaPreset)

  // Storage stub: every getter returns [] unless the section is seeded below.
  const makeStore = (seed: { catalogs?: DataCatalog[]; ruleSets?: DqRuleSet[]; checks?: DqCustomCheck[]; presets?: CustomSchemaPreset[]; dataSources?: unknown[]; idRanges?: unknown[]; idEntries?: unknown[] } = {}) => {
    const table = (methods: Record<string, unknown>) => new Proxy(methods, {
      get: (t, prop) => (typeof prop === 'string' && prop in t ? (t as Record<string, unknown>)[prop] : async () => []),
    })
    return new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'workspaces': return table({ getById: async () => ({ id: 'w1', name: { en: 'W' }, description: {} }) })
          case 'organizations': return table({ getById: async () => undefined })
          case 'dataCatalogs': return table({ getByWorkspace: async () => seed.catalogs ?? [] })
          case 'dqRuleSets': return table({ getByWorkspace: async () => seed.ruleSets ?? [] })
          case 'dqCustomChecks': return table({ getByRuleSet: async () => seed.checks ?? [] })
          case 'schemaPresets': return table({ getByWorkspace: async () => seed.presets ?? [] })
          case 'dataSources': return table({ getByWorkspace: async () => seed.dataSources ?? [] })
          case 'sourceConceptIdRanges': return table({ getByWorkspace: async () => seed.idRanges ?? [] })
          case 'sourceConceptIdEntries': return table({ getByWorkspace: async () => seed.idEntries ?? [] })
          default: return table({})
        }
      },
    }) as unknown as Storage
  }

  const ONLY = { schemas: true, dataQuality: true, catalogs: true, databases: true } as unknown as NonNullable<Parameters<typeof buildWorkspaceZip>[2]>['sections']

  const exportZip = async (seed: Parameters<typeof makeStore>[0]) => {
    const built = await buildWorkspaceZip('w1', makeStore(seed), { sections: ONLY })
    return JSZip.loadAsync(await built!.blob.arrayBuffer())
  }
  const readGitLinks = async (zip: JSZip) =>
    JSON.parse(await zip.files['git-links.json'].async('string')) as { links: { type: string; id: string; folder: string; url: string; branch: string }[] }

  it('writes root source-concept-ids/ranges.json but NOT root entries.json', async () => {
    // Ownership model: the workspace root holds only the badge RANGES; ENTRIES
    // belong to each mapping project's subfolder. Even with entries in the
    // registry, the root entries.json must not be written.
    const CM_ONLY = { conceptMapping: true } as unknown as NonNullable<Parameters<typeof buildWorkspaceZip>[2]>['sections']
    const built = await buildWorkspaceZip('w1', makeStore({
      idRanges: [{ workspaceId: 'w1', badgeLabel: 'Rennes', rangeStart: 2000000001, rangeEnd: 2001000000, nextId: 2000000042, totalConcepts: 41, createdAt: '2020', updatedAt: '2021' }],
      idEntries: [{ id: 'w1__Rennes__LOINC__1234-5', workspaceId: 'w1', badgeLabel: 'Rennes', vocabularyId: 'LOINC', conceptCode: '1234-5', sourceConceptId: 2000000001, createdAt: '2020' }],
    }), { sections: CM_ONLY })
    const zip = await JSZip.loadAsync(await built!.blob.arrayBuffer())
    expect(zip.files['source-concept-ids/ranges.json']).toBeDefined()
    expect(zip.files['source-concept-ids/entries.json']).toBeUndefined()
  })

  it('exports a real database but skips an ATHENA vocabulary reference', async () => {
    const zip = await exportZip({
      dataSources: [
        { id: 'ds-real', workspaceId: 'w1', name: 'My Postgres', sourceType: 'database', status: 'connected', createdAt: '2020', updatedAt: '2021' },
        { id: 'ds-vocab', workspaceId: 'w1', name: 'ATHENA vocabulary - Adult ICU Rennes', sourceType: 'database', status: 'connected', isVocabularyReference: true, createdAt: '2020', updatedAt: '2021' },
      ],
    })
    // The real DB is versioned; the vocabulary reference (internal ATHENA target
    // vocabulary) is not — it must not appear as a phantom database.
    expect(zip.files['databases/my-postgres.json']).toBeDefined()
    expect(zip.files['databases/athena-vocabulary-adult-icu-rennes.json']).toBeUndefined()
    expect(Object.keys(zip.files).filter(p => p.startsWith('databases/') && p.endsWith('.json'))).toHaveLength(1)
  })

  it('writes a folder marker + git-links entry for a linked data-catalog', async () => {
    const zip = await exportZip({ catalogs: [CATALOG({ gitRemoteConfig: GIT })] })
    const marker = zip.files['catalogs/my-catalog/entity.json']
    expect(marker).toBeDefined()
    // The pointer carries the portable slug and the lineage, never the writing
    // instance's local key.
    const markerMeta = JSON.parse(await marker.async('string'))
    expect(markerMeta.id).toBeUndefined()
    expect(markerMeta.entityId).toBe('my-catalog')
    // No flat form when linked.
    expect(zip.files['catalogs/my-catalog.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'data-catalog', id: 'cat-1', folder: 'my-catalog', url: GIT.url, branch: 'main' })
    // git-links.json is written from the LOCAL rows, so it keeps the local id:
    // it is this instance's index of what to clone, not part of an entity's
    // portable metadata.
  })

  it('writes a minimal-pointer marker + git-links entry for a linked dq-rule-set (checks live in the repo)', async () => {
    const zip = await exportZip({ ruleSets: [RULESET({ gitRemoteConfig: GIT })], checks: [CHECK()] })
    const marker = zip.files['data-quality/my-ruleset/entity.json']
    expect(marker).toBeDefined()
    const pointer = JSON.parse(await marker.async('string'))
    // Flat, like every other linked kind — it used to nest itself under `ruleSet`,
    // which was also the last manifest still writing the local `id`.
    expect(pointer.entityId).toBe('my-ruleset')
    expect(pointer.type).toBe('dq-rule-set')
    expect(pointer.id).toBeUndefined()
    expect(pointer.gitRemoteConfig).toEqual(GIT)
    // Pointer only — the linked repo's checks.json is the source of truth, so the
    // workspace marker carries no checks of its own.
    expect(pointer.checks).toBeUndefined()
    expect(zip.files['data-quality/my-ruleset.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'dq-rule-set', id: 'rs-1', folder: 'my-ruleset', url: GIT.url, branch: 'main' })
  })

  it('writes a folder marker + git-links entry for a linked schema-preset', async () => {
    const zip = await exportZip({ presets: [PRESET({ gitRemoteConfig: GIT })] })
    const marker = zip.files['schemas/my-preset/entity.json']
    expect(marker).toBeDefined()
    const presetPtr = JSON.parse(await marker.async('string'))
    expect(presetPtr.entityId).toBe('my-preset')
    expect(presetPtr.type).toBe('schema-preset')
    // The payload lives in the linked repo's mapping.json; the pointer keeps the
    // promoted display name instead of inlining `mapping`.
    expect(presetPtr.mapping).toBeUndefined()
    expect(presetPtr.name).toEqual({ en: 'My Preset' })
    expect(zip.files['schemas/my-preset.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'schema-preset', id: 'my-preset', folder: 'my-preset', url: GIT.url, branch: 'main' })
  })

  it('keeps the flat form (no marker, no git-links) when the entity is NOT linked', async () => {
    const zip = await exportZip({
      catalogs: [CATALOG()], ruleSets: [RULESET()], checks: [CHECK()], presets: [PRESET()],
    })
    expect(zip.files['catalogs/my-catalog.json']).toBeDefined()
    expect(zip.files['catalogs/my-catalog/entity.json']).toBeUndefined()
    expect(zip.files['data-quality/my-ruleset.json']).toBeDefined()
    expect(zip.files['schemas/my-preset.json']).toBeDefined()
    expect(zip.files['git-links.json']).toBeUndefined()
  })

  it('parseWorkspaceZip + collectGitLinkedEntities discover the 3 linked entities from their markers', async () => {
    const zip = await exportZip({
      catalogs: [CATALOG({ gitRemoteConfig: GIT })],
      ruleSets: [RULESET({ gitRemoteConfig: GIT })], checks: [CHECK()],
      presets: [PRESET({ gitRemoteConfig: GIT })],
    })
    // JSZip.loadAsync reads an ArrayBuffer fine in jsdom; a wrapped File does not.
    const file = await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
    const parsed = await parseWorkspaceZip(file)
    const linked = collectGitLinkedEntities(parsed!)
    expect(linked.map(l => l.type).sort()).toEqual(['data-catalog', 'dq-rule-set', 'schema-preset'])
    // The id is minted by the parser now (the pointer carries none), so only the
    // git coordinates are asserted — they are what the clone actually needs.
    expect(linked.find(l => l.type === 'data-catalog')).toMatchObject({ url: GIT.url, branch: 'main' })
  })

  it('applyClonedEntity restores each type from its own repo layout', async () => {
    const calls: Record<string, unknown[][]> = {}
    const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'dataCatalogs': return { update: rec('catalog.update') }
          case 'dqRuleSets': return { update: rec('rs.update') }
          case 'dqCustomChecks': return { deleteByRuleSet: rec('chk.delete'), create: rec('chk.create') }
          case 'schemaPresets': return { save: rec('preset.save'), getById: async () => undefined }
          default: return new Proxy({}, { get: () => async () => {} })
        }
      },
    }) as unknown as Storage

    const catZip = new JSZip(); catZip.file('catalog.json', JSON.stringify(CATALOG({ id: 'ignored' })))
    expect(await applyClonedEntity(catZip, 'data-catalog', 'cat-target', store)).toBe(true)
    // targetId wins; the repo's own id is stripped from the applied changes.
    expect(calls['catalog.update']![0][0]).toBe('cat-target')
    expect((calls['catalog.update']![0][1] as { id?: string }).id).toBeUndefined()

    const rsZip = new JSZip()
    rsZip.file('rule-set.json', JSON.stringify(RULESET({ id: 'ignored' })))
    rsZip.file('checks.json', JSON.stringify([CHECK({ ruleSetId: 'ignored' })]))
    expect(await applyClonedEntity(rsZip, 'dq-rule-set', 'rs-target', store)).toBe(true)
    expect(calls['rs.update']![0][0]).toBe('rs-target')
    expect(calls['chk.delete']![0][0]).toBe('rs-target')
    // Checks are recreated under the target rule set, not the repo's stale FK.
    expect((calls['chk.create']![0][0] as { ruleSetId: string }).ruleSetId).toBe('rs-target')

    const spZip = new JSZip()
    spZip.file('preset.json', JSON.stringify(PRESET()))
    spZip.file('schema.ddl', 'CREATE TABLE person ();')
    expect(await applyClonedEntity(spZip, 'schema-preset', 'preset-target', store)).toBe(true)
    const saved = calls['preset.save']![0][0] as {
      presetId: string
      id?: string
      entityId?: string
      mapping?: { ddl?: string; presetId?: string }
    }
    expect(saved.presetId).toBe('preset-target')
    // A clone mints its OWN local key — the repo's belongs to whichever
    // instance wrote it. The published identity travels in lineageId.
    expect(saved.id).toEqual(expect.any(String))
    expect(saved.entityId).toBe('preset-target')
    // The mapping's own id follows the entity's. Letting them drift meant a
    // later ZIP import — which reads mapping.presetId as the entity id and
    // deletes whatever holds it — deleted a different preset.
    expect(saved.mapping?.presetId).toBe('preset-target')
    // The DDL is its own file in the repo; the import folds it back into the mapping.
    expect(saved.mapping?.ddl).toBe('CREATE TABLE person ();')
  })

  it('gives a cloned preset a lineage, minting one when the repo has none', async () => {
    // The four published schema repos were exported before lineage existed. The
    // spread that copies the repo left those clones with no lineageId at all —
    // unrecognisable to any other instance, and to findInstalled except by git URL.
    const cloneOf = async (repoPreset: CustomSchemaPreset, existing?: CustomSchemaPreset) => {
      const saves: unknown[] = []
      const store = new Proxy({}, {
        get: (_t, prop) => prop === 'schemaPresets'
          ? { save: (p: unknown) => { saves.push(p); return Promise.resolve() }, getById: async () => existing }
          : new Proxy({}, { get: () => async () => {} }),
      }) as unknown as Storage
      const zip = new JSZip()
      zip.file('preset.json', JSON.stringify(repoPreset))
      zip.file('schema.ddl', 'CREATE TABLE person ();')
      await applyClonedEntity(zip, 'schema-preset', 'preset-target', store)
      return saves[0] as CustomSchemaPreset
    }

    // A repo with no lineage still yields a row that has one.
    const minted = await cloneOf(PRESET())
    expect(minted.lineageId).toEqual(expect.any(String))
    expect(minted.lineageId).not.toBe('')

    // A repo that publishes a lineage keeps that value verbatim — it IS the
    // cross-instance identity, so re-minting would fork the entity.
    const published = await cloneOf(PRESET({ lineageId: 'lin-published' } as Partial<CustomSchemaPreset>))
    expect(published.lineageId).toBe('lin-published')

    // A re-clone (pull) keeps the row's stored lineage rather than minting anew.
    const reclone = await cloneOf(
      PRESET(),
      PRESET({ lineageId: 'lin-local' } as Partial<CustomSchemaPreset>),
    )
    expect(reclone.lineageId).toBe('lin-local')
  })

  describe('applyClonedEntity: database', () => {
    /** A store recording data-source and file writes, with everything else inert. */
    function makeStore(): { store: Storage; calls: Record<string, unknown[][]> } {
      const calls: Record<string, unknown[][]> = {}
      const rec = (name: string) => (...args: unknown[]) => {
        (calls[name] ??= []).push(args)
        return Promise.resolve()
      }
      const store = new Proxy({}, {
        get: (_t, prop) => {
          switch (prop) {
            case 'dataSources': return {
              getAll: async () => [],
              getById: async () => null,
              create: rec('ds.create'),
              update: rec('ds.update'),
            }
            case 'files': return {
              getByDataSource: async () => [],
              create: rec('file.create'),
              delete: rec('file.delete'),
            }
            default: return new Proxy({}, { get: () => async () => {} })
          }
        },
      }) as unknown as Storage
      return { store, calls }
    }

    const META = (over: Record<string, unknown> = {}) => JSON.stringify({
      id: 'mimic-iv-demo',
      alias: 'mimic_iv_demo',
      name: { en: 'MIMIC-IV Demo' },
      sourceType: 'database',
      schema: 'mimic-iv',
      tables: ['patients', 'admissions'],
      ...over,
    })

    it('stores each declared Parquet and points the source at them', async () => {
      const { store, calls } = makeStore()
      const zip = new JSZip()
      zip.file('_database.json', META())
      zip.file('data/patients.parquet', new Uint8Array([1, 2, 3]))
      zip.file('data/admissions.parquet', new Uint8Array([4, 5]))

      expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
      expect(calls['file.create']).toHaveLength(2)
      const created = calls['ds.create']![0][0] as { id: string }
      expect(created.id).toBe('db-target')
      // The row is written first (server mode registers files against it), so the
      // file list arrives in the follow-up update rather than at creation.
      const patched = calls['ds.update']!.at(-1)![1] as {
        connectionConfig: { fileNames: string[]; fileIds: string[] }
      }
      expect(patched.connectionConfig.fileNames.sort())
        .toEqual(['admissions.parquet', 'patients.parquet'])
      expect(patched.connectionConfig.fileIds).toHaveLength(2)
    })

    it('refuses a schema id this instance cannot resolve', async () => {
      // Falling back to an empty mapping would import a database the app cannot
      // read one table from, with nothing saying why.
      const { store } = makeStore()
      const zip = new JSZip()
      zip.file('_database.json', META({ schema: 'not-installed-anywhere' }))
      await expect(applyClonedEntity(zip, 'database', 'db-target', store))
        .rejects.toThrow(/not installed/)
    })

    it('imports the metadata when a declared table has no file', async () => {
      // Data files are gitignored in many trees; the database should still land
      // rather than the whole install failing.
      const { store, calls } = makeStore()
      const zip = new JSZip()
      zip.file('_database.json', META())
      zip.file('data/patients.parquet', new Uint8Array([1]))

      expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
      expect(calls['file.create']).toHaveLength(1)
    })

    it('accepts an inline mapping with no installed preset', async () => {
      const { store, calls } = makeStore()
      const zip = new JSZip()
      zip.file('_database.json', META({
        schema: { presetId: 'inline', presetLabel: { en: 'Inline' }, eventTables: {} },
        tables: [],
      }))
      expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
      const created = calls['ds.create']![0][0] as { schemaMapping: { presetId: string } }
      expect(created.schemaMapping.presetId).toBe('inline')
    })

    it('returns false when the repo carries no _database.json', async () => {
      const { store } = makeStore()
      expect(await applyClonedEntity(new JSZip(), 'database', 'db-target', store)).toBe(false)
    })

    // The cases above hand-write `schema`, so none of them noticed that the
    // exporter published `schemaMapping` instead — a database repo exported by
    // the app failed its own import with "declares the schema undefined".
    // Round-trip through the real writer so the two names can never drift again.
    it('re-imports a tree the app itself exported', async () => {
      const mapping = {
        presetId: 'inline', presetLabel: { en: 'Inline' }, eventTables: {},
        ddl: 'CREATE TABLE t (x INT);',
      }
      const out = new JSZip()
      await buildDataSourceFolder(out, '', {
        id: 'db1', alias: 'db', name: { en: 'DB' }, description: {},
        sourceType: 'database', schemaMapping: mapping,
        connectionConfig: { engine: 'duckdb', password: 'secret' },
      } as unknown as Parameters<typeof buildDataSourceFolder>[2], new Proxy({}, {
        get: () => new Proxy({}, { get: () => async () => [] }),
      }) as unknown as Storage)

      // The mapping and its DDL are their own files, as a schema preset writes
      // them; the manifest keeps identity and provenance only.
      const meta = JSON.parse(await out.files['entity.json'].async('string')) as Record<string, unknown>
      expect(meta.schema).toBeUndefined()
      expect('schemaMapping' in meta).toBe(false)
      const written = JSON.parse(await out.files['mapping.json'].async('string')) as Record<string, unknown>
      expect(written.presetId).toBe('inline')
      expect(written.ddl).toBeUndefined()
      expect(await out.files['schema.ddl'].async('string')).toBe('CREATE TABLE t (x INT);')
      // The metadata-only rule still holds: no credentials travel.
      expect(meta.connectionConfig).toEqual({ engine: 'duckdb' })

      const { store, calls } = makeStore()
      const back = new JSZip()
      back.file('entity.json', JSON.stringify(meta))
      back.file('mapping.json', JSON.stringify(written))
      back.file('schema.ddl', 'CREATE TABLE t (x INT);')
      expect(await applyClonedEntity(back, 'database', 'db-target', store)).toBe(true)
      const created = calls['ds.create']![0][0] as {
        schemaMapping: { presetId: string; ddl: string }
      }
      expect(created.schemaMapping.presetId).toBe('inline')
      // The DDL is recombined on read, so the row holds the whole mapping again.
      expect(created.schemaMapping.ddl).toBe('CREATE TABLE t (x INT);')
    })

    it('still reads a tree with the mapping inline', async () => {
      // Databases published before the split carry `schema` in the manifest.
      const { store, calls } = makeStore()
      const zip = new JSZip()
      zip.file('_database.json', META({
        schema: { presetId: 'inline', presetLabel: { en: 'Inline' }, eventTables: {} },
        tables: [],
      }))
      expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
      const created = calls['ds.create']![0][0] as { schemaMapping: { presetId: string } }
      expect(created.schemaMapping.presetId).toBe('inline')
    })

    describe('ZIP import (Databases page)', () => {
      /** A database repo as a ZIP file, one root folder deep like a git download. */
      async function repoZip(over: Record<string, unknown> = {}): Promise<File> {
        const zip = new JSZip()
        zip.file('mimic-iv-demo/entity.json', META(over))
        zip.file('mimic-iv-demo/data/patients.parquet', new Uint8Array([1, 2, 3]))
        zip.file('mimic-iv-demo/data/admissions.parquet', new Uint8Array([4, 5]))
        return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
      }

      it('reads the manifest through a root folder, keeping Parquet as bytes', async () => {
        const parsed = await parseDatabaseZip(await repoZip())
        expect(parsed?.id).toBe('mimic-iv-demo')
        expect(parsed?.name).toEqual({ en: 'MIMIC-IV Demo' })
        expect(parsed?.tableCount).toBe(2)

        // parseImportZip would have decoded these as text and corrupted them.
        const { store, calls } = makeStore()
        await importParsedDatabase(parsed!, store, false)
        const files = calls['file.create']!.map((c) => c[0] as { fileSize: number })
        expect(files.map((f) => f.fileSize).sort()).toEqual([2, 3])
      })

      it('overwrite reuses the repo id, duplicate mints a fresh one', async () => {
        const parsed = (await parseDatabaseZip(await repoZip()))!

        const over = makeStore()
        expect(await importParsedDatabase(parsed, over.store, false)).toBe('mimic-iv-demo')

        const dup = makeStore()
        const dupId = await importParsedDatabase(parsed, dup.store, true)
        expect(dupId).not.toBe('mimic-iv-demo')
        expect(dupId).toBeTruthy()
      })

      it('renames a duplicate whose alias is already taken', async () => {
        // The alias names the DuckDB schema (ds_<alias>), so a copy keeping the
        // original's alias would shadow the original's tables.
        const parsed = (await parseDatabaseZip(await repoZip()))!
        const calls: Record<string, unknown[][]> = {}
        let stored: { id: string; alias: string } | null = null
        const store = new Proxy({}, {
          get: (_t, prop) => {
            switch (prop) {
              case 'dataSources': return {
                getAll: async () => [{ id: 'other', alias: 'mimic_iv_demo' }],
                getById: async () => stored,
                create: async (ds: { id: string; alias: string }) => { stored = ds },
                update: async (_id: string, ch: Record<string, unknown>) => {
                  (calls['ds.update'] ??= []).push([ch])
                  if (stored && typeof ch.alias === 'string') stored.alias = ch.alias
                },
              }
              case 'files': return {
                getByDataSource: async () => [],
                create: async () => {},
                delete: async () => {},
              }
              default: return new Proxy({}, { get: () => async () => {} })
            }
          },
        }) as unknown as Storage

        await importParsedDatabase(parsed, store, true)
        expect(stored!.alias).toBe('mimic_iv_demo_2')
      })

      it('creates the data source before registering its files', async () => {
        // Server mode registers each blob AGAINST the source row, so storing
        // files first made the API answer a bare 404 ("Not found") that named
        // nothing — the import failed with no usable message.
        const order: string[] = []
        const store = new Proxy({}, {
          get: (_t, prop) => {
            switch (prop) {
              case 'dataSources': return {
                getAll: async () => [],
                getById: async () => null,
                create: async () => { order.push('source') },
                update: async () => { order.push('update') },
              }
              case 'files': return {
                getByDataSource: async () => [],
                create: async () => { order.push('file') },
                delete: async () => {},
              }
              default: return new Proxy({}, { get: () => async () => {} })
            }
          },
        }) as unknown as Storage

        const zip = new JSZip()
        zip.file('_database.json', META())
        zip.file('data/patients.parquet', new Uint8Array([1]))
        zip.file('data/admissions.parquet', new Uint8Array([2]))
        expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
        expect(order.indexOf('source')).toBeLessThan(order.indexOf('file'))
      })

      it('leaves the imported database connected, not configuring', async () => {
        // Server mode skipped the connect step entirely (it is the browser mount
        // that it rightly avoids), so the database sat at 'configuring' with its
        // data present: the Schema tab refused to browse it and its card read
        // "Configuring". A Parquet database is a file source — the files being
        // uploaded is what "connected" means, there is no live connection.
        serverMode.value = true
        let row: Record<string, unknown> | null = null
        const store = new Proxy({}, {
          get: (_t, prop) => {
            switch (prop) {
              case 'dataSources': return {
                getAll: async () => [],
                getById: async () => row,
                create: async (ds: Record<string, unknown>) => { row = ds },
                update: async (_id: string, ch: Record<string, unknown>) => {
                  if (row) Object.assign(row, ch)
                },
              }
              case 'files': return {
                getByDataSource: async () => [],
                create: async () => {},
                delete: async () => {},
              }
              default: return new Proxy({}, { get: () => async () => {} })
            }
          },
        }) as unknown as Storage

        try {
          const zip = new JSZip()
          zip.file('_database.json', META())
          zip.file('data/patients.parquet', new Uint8Array([1]))
          zip.file('data/admissions.parquet', new Uint8Array([2]))
          expect(await applyClonedEntity(zip, 'database', 'db-target', store)).toBe(true)
          expect(row!.status).toBe('connected')
        } finally {
          serverMode.value = false
        }
      })

      it('returns null for a ZIP that is not a database repo', async () => {
        const zip = new JSZip()
        zip.file('project.json', '{}')
        expect(await parseDatabaseZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)).toBeNull()
      })
    })
  })

  it('refuses a schema-preset repo with no schema.ddl', async () => {
    // The DDL is what creates the tables. Importing without it would produce a
    // preset that silently creates nothing, so an unreadable repo is the honest
    // answer.
    const store = new Proxy({}, {
      get: () => new Proxy({}, { get: () => async () => {} }),
    }) as unknown as Storage
    const spZip = new JSZip()
    spZip.file('preset.json', JSON.stringify(PRESET()))
    expect(await applyClonedEntity(spZip, 'schema-preset', 'preset-target', store)).toBe(false)
  })

  it('applyClonedEntity recombines LICENSE.md/README.md with the entity JSON', async () => {
    // The entity JSON carries only HALF a licence: `stripEntityDocs` writes its
    // id + name there and the TEXT to LICENSE.md beside it. Applying the JSON
    // alone replaced a complete local licence with a text-less stub — the export
    // then omitted LICENSE.md (it read as "deleted" on the next push) and the
    // licence editor crashed on the missing text. Same bug as the ETL settings
    // block, found on these three scopes by auditing the others.
    const calls: Record<string, unknown[][]> = {}
    const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'dataCatalogs': return { update: rec('catalog.update') }
          case 'dqRuleSets': return { update: rec('rs.update') }
          case 'dqCustomChecks': return { deleteByRuleSet: rec('chk.delete'), create: rec('chk.create') }
          case 'schemaPresets': return { save: rec('preset.save'), getById: async () => undefined }
          default: return new Proxy({}, { get: () => async () => {} })
        }
      },
    }) as unknown as Storage

    const withDocs = (zip: JSZip) => {
      zip.file('LICENSE.md', 'MIT License\n\nFull text here.')
      zip.file('README.md', '# Docs')
      return zip
    }
    // What the export actually writes: id + name only, no text.
    const licenseMeta = { license: { id: 'mit', name: 'MIT' } }

    const catZip = withDocs(new JSZip())
    catZip.file('catalog.json', JSON.stringify({ ...CATALOG({ id: 'x' }), ...licenseMeta }))
    await applyClonedEntity(catZip, 'data-catalog', 'cat-target', store)
    const cat = calls['catalog.update']![0][1] as { license?: { text?: string }; readme?: Record<string, string> }
    expect(cat.license?.text).toContain('Full text here.')
    expect(cat.readme?.en).toBe('# Docs')

    const rsZip = withDocs(new JSZip())
    rsZip.file('rule-set.json', JSON.stringify({ ...RULESET({ id: 'x' }), ...licenseMeta }))
    await applyClonedEntity(rsZip, 'dq-rule-set', 'rs-target', store)
    expect((calls['rs.update']![0][1] as { license?: { text?: string } }).license?.text)
      .toContain('Full text here.')

    const spZip = withDocs(new JSZip())
    spZip.file('preset.json', JSON.stringify({ ...PRESET(), ...licenseMeta }))
    spZip.file('schema.ddl', 'CREATE TABLE person ();')
    await applyClonedEntity(spZip, 'schema-preset', 'preset-target', store)
    expect((calls['preset.save']![0][0] as { license?: { text?: string } }).license?.text)
      .toContain('Full text here.')
  })

  it('applyClonedEntity restores a mapping project with source concepts + mappings (not metadata only)', async () => {
    const calls: Record<string, unknown[][]> = {}
    const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'mappingProjects': return { create: rec('mp.create'), delete: rec('mp.delete') }
          case 'conceptMappings': return { createBatch: rec('cm.createBatch'), deleteByProject: rec('cm.deleteByProject') }
          default: return new Proxy({}, { get: () => async () => {} })
        }
      },
    }) as unknown as Storage

    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      id: 'repo-id', name: { en: 'Adult ICU' }, sourceType: 'file',
      fileSourceData: { fileName: 'source-concepts.csv', rows: [], columns: [], columnMapping: {} },
    }))
    zip.file('source-concepts.csv', 'concept_name,concept_code\nHeart rate,HR')
    zip.file('mappings.json', JSON.stringify([{ id: 'm1', sourceConceptCode: 'HR', targetConceptId: 42, comments: [] }]))

    const ok = await applyClonedEntity(zip, 'mapping-project', 'mp-target', store, 'ws-9', { url: 'https://example/adult', branch: 'main' })
    expect(ok).toBe(true)
    // Project written under the target id + workspace, with source concepts from the CSV.
    const created = calls['mp.create']![0][0] as { id: string; workspaceId: string; gitRemoteConfig?: { url: string }; fileSourceData: { columns: string[] } }
    expect(created.id).toBe('mp-target')
    expect(created.workspaceId).toBe('ws-9')
    // Git link kept so the entity stays git-linked on re-export.
    expect(created.gitRemoteConfig).toEqual({ url: 'https://example/adult', branch: 'main' })
    expect(created.fileSourceData.columns).toEqual(['concept_name', 'concept_code'])
    // Mappings recreated under the target (the "no concepts" bug was these being dropped).
    const batch = calls['cm.createBatch']![0][0] as Array<{ projectId: string }>
    expect(batch).toHaveLength(1)
    expect(batch[0].projectId).toBe('mp-target')
  })

  const sqlCollectionRepoZip = (legacy = false) => {
    const zip = new JSZip()
    zip.file('_collection.json', JSON.stringify({ id: 'repo-col', name: { en: 'Scripts' } }))
    zip.file('_tree.json', JSON.stringify(legacy
      ? [
        { id: 'f-folder', collectionId: 'repo-col', name: 'sofa', type: 'folder', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'f-file', collectionId: 'repo-col', name: 'sofa.sql', type: 'file', parentId: 'f-folder', order: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      ]
      : [
        { path: 'sofa', type: 'folder', order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
        { path: 'sofa/sofa.sql', type: 'file', order: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      ]))
    zip.file('sofa/sofa.sql', 'select 1')
    return zip
  }
  const sqlStore = (calls: Record<string, unknown[][]>) => {
    const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
    return new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'sqlScriptCollections') return { update: rec('col.update') }
        if (prop === 'sqlScriptFiles') return {
          deleteByCollection: rec('files.deleteByCollection'),
          create: rec('files.create'),
        }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
  }
  const createdNodes = (calls: Record<string, unknown[][]>) =>
    calls['files.create']!.map((a) => a[0] as { id: string; name: string; parentId: string | null; collectionId: string; content?: string; path?: string })

  it('applyClonedEntity derives file ids from the path, keeping the tree and content intact', async () => {
    const calls: Record<string, unknown[][]> = {}
    expect(await applyClonedEntity(sqlCollectionRepoZip(), 'sql-collection', 'sql-target', sqlStore(calls))).toBe(true)
    expect(calls['files.deleteByCollection']).toHaveLength(1)
    const created = createdNodes(calls)
    // Parent before child, names recovered from the path, FK repointed at the target.
    expect(created.map((f) => f.name)).toEqual(['sofa', 'sofa.sql'])
    expect(created[0].parentId).toBeNull()
    expect(created[1].parentId).toBe(created[0].id)
    expect(created.every((f) => f.collectionId === 'sql-target')).toBe(true)
    expect(created[1].content).toBe('select 1')
    // The transport-only `path` never reaches storage.
    expect(created.every((f) => f.path === undefined)).toBe(true)
  })

  it('applyClonedEntity is idempotent across re-clones and distinct per target collection', async () => {
    const first: Record<string, unknown[][]> = {}
    const again: Record<string, unknown[][]> = {}
    const sibling: Record<string, unknown[][]> = {}
    await applyClonedEntity(sqlCollectionRepoZip(), 'sql-collection', 'sql-target', sqlStore(first))
    await applyClonedEntity(sqlCollectionRepoZip(), 'sql-collection', 'sql-target', sqlStore(again))
    await applyClonedEntity(sqlCollectionRepoZip(), 'sql-collection', 'other-target', sqlStore(sibling))
    // Same repo + same collection → same ids: a re-clone can't churn _tree.json.
    expect(createdNodes(again).map((f) => f.id)).toEqual(createdNodes(first).map((f) => f.id))
    // Same repo cloned into a second collection → disjoint ids, so the global PK holds.
    const ids = new Set(createdNodes(first).map((f) => f.id))
    expect(createdNodes(sibling).every((f) => !ids.has(f.id))).toBe(true)
  })

  it('applyClonedEntity still reads a legacy id/parentId _tree.json (repos pushed before the path format)', async () => {
    const calls: Record<string, unknown[][]> = {}
    expect(await applyClonedEntity(sqlCollectionRepoZip(true), 'sql-collection', 'sql-target', sqlStore(calls))).toBe(true)
    const created = createdNodes(calls)
    expect(created.map((f) => f.name)).toEqual(['sofa', 'sofa.sql'])
    expect(created[1].parentId).toBe(created[0].id)
    expect(created[1].content).toBe('select 1')
    // Legacy repo ids are dropped, not persisted.
    expect(created.every((f) => f.id !== 'f-folder' && f.id !== 'f-file')).toBe(true)
  })

  it('applyClonedEntity keeps INLINE content when the tree carries it and the ZIP has no raw file', async () => {
    // The oldest layout (collection.json + files.json) stored content inline with no
    // .sql entry alongside; dropping it imported every script empty.
    const zip = new JSZip()
    zip.file('_collection.json', JSON.stringify({ id: 'repo-col', name: { en: 'Scripts' } }))
    zip.file('_tree.json', JSON.stringify([
      { id: 'f-file', collectionId: 'repo-col', name: 'inline.sql', type: 'file', parentId: null, content: 'select 42', order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
    ]))
    const calls: Record<string, unknown[][]> = {}
    expect(await applyClonedEntity(zip, 'sql-collection', 'sql-target', sqlStore(calls))).toBe(true)
    expect(createdNodes(calls)[0].content).toBe('select 42')
  })

  it('applyClonedEntity returns false when the cloned repo lacks the expected marker', async () => {
    const store = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => {} }) }) as unknown as Storage
    expect(await applyClonedEntity(new JSZip(), 'data-catalog', 'x', store)).toBe(false)
    expect(await applyClonedEntity(new JSZip(), 'dq-rule-set', 'x', store)).toBe(false)
    expect(await applyClonedEntity(new JSZip(), 'schema-preset', 'x', store)).toBe(false)
  })
})

// Dashboard/tab/widget ids are derived from CONTENT keys namespaced by the LOCAL
// projectUid. Two goals, in tension, both satisfied:
//   (1) Re-import into the SAME project uid → identical ids → byte-stable git
//       round-trip (delete + reimport = zero diff).
//   (2) Import into a DIFFERENT project uid (e.g. the same lineage cloned into a
//       second workspace) → DISTINCT ids → no global-PK collision. Namespacing by
//       the shared lineageId instead used to collide here, surfacing as an
//       unhandled 500 (UNIQUE constraint failed) on POST /dashboards.
describe('§4 projectUid-scoped dashboard ids', () => {
  type Captured = {
    dashboards: Record<string, unknown>[]
    tabs: Record<string, unknown>[]
    widgets: Record<string, unknown>[]
  }
  const makeStore = () => {
    const cap: Captured = { dashboards: [], tabs: [], widgets: [] }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'dashboards') return { create: async (d: Record<string, unknown>) => { cap.dashboards.push(d) } }
        if (prop === 'dashboardTabs') return { create: async (t: Record<string, unknown>) => { cap.tabs.push(t) } }
        if (prop === 'dashboardWidgets') return { create: async (w: Record<string, unknown>) => { cap.widgets.push(w) } }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
    return { store, cap }
  }

  // A clean git-versioned bundle: project has lineageId but NO uid; tabs carry
  // key/parentKey (a root tab + one sub-tab), widgets carry key/tabKey, and the
  // dashboard's filterConfig has no id and a key-based scope.
  const cleanBundle = (): ParsedProjectZip => ({
    project: { name: { en: 'P' }, lineageId: 'lin-abc' } as unknown as ParsedProjectZip['project'],
    ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
    dashboards: [{
      projectUid: '', name: { en: 'Overview' }, gridV: 2,
      filterConfig: [{
        datasetFileId: 'data.csv', columnId: 'col_sex', columnName: 'sex',
        type: 'categorical', inputType: 'multi-select',
        scope: { type: 'tabs', tabKeys: ['overview/summary'] },
      }],
    } as unknown as ParsedProjectZip['dashboards'][number]],
    dashboardTabs: [
      { key: 'overview/summary', parentKey: null, name: { en: 'Summary' }, displayOrder: 0 } as unknown as ParsedProjectZip['dashboardTabs'][number],
      { key: 'overview/summary/detail', parentKey: 'overview/summary', name: { en: 'Detail' }, displayOrder: 1 } as unknown as ParsedProjectZip['dashboardTabs'][number],
    ],
    dashboardWidgets: [
      { key: 'overview/summary/kpi@0,0', tabKey: 'overview/summary', name: { en: 'KPI' }, layout: { x: 0, y: 0, w: 4, h: 2 }, source: { type: 'inline', language: 'sql', code: '', config: {} } } as unknown as ParsedProjectZip['dashboardWidgets'][number],
    ],
    datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
    attachmentsMeta: [], attachmentBlobs: new Map(),
  })

  beforeEach(() => { serverMode.value = false })

  it('re-derives IDENTICAL ids for the same clean bundle imported into the SAME uid (round-trip stability)', async () => {
    const a = makeStore()
    const b = makeStore()
    await importProjectContent(cleanBundle(), 'uidA', a.store)
    await importProjectContent(cleanBundle(), 'uidA', b.store)

    const da = a.cap.dashboards[0] as { id: string; filterConfig: { id: string; scope: { tabIds: string[] } }[] }
    const db = b.cap.dashboards[0] as { id: string; filterConfig: { id: string; scope: { tabIds: string[] } }[] }
    const ta = a.cap.tabs as { id: string }[]
    const tb = b.cap.tabs as { id: string }[]
    const wa = a.cap.widgets[0] as { id: string }
    const wb = b.cap.widgets[0] as { id: string }

    // Same uid → zero-diff: every derived id matches.
    expect(da.id).toBe(db.id)
    expect(da.filterConfig[0].id).toBe(db.filterConfig[0].id)
    expect(ta.map(t => t.id)).toEqual(tb.map(t => t.id))
    expect(wa.id).toBe(wb.id)
  })

  it('re-derives DISTINCT ids across two different project uids (no global-PK collision)', async () => {
    const a = makeStore()
    const b = makeStore()
    // Same lineageId in both bundles — the collision case: the shared lineage must
    // NOT drive the id, or the second import collides on dashboards.id.
    await importProjectContent(cleanBundle(), 'uidA', a.store)
    await importProjectContent(cleanBundle(), 'uidB', b.store)

    const da = a.cap.dashboards[0] as { id: string }
    const db = b.cap.dashboards[0] as { id: string }
    const wa = a.cap.widgets[0] as { id: string }
    const wb = b.cap.widgets[0] as { id: string }

    expect(da.id).not.toBe(db.id)
    expect(wa.id).not.toBe(wb.id)
  })

  it('keeps FK relationships internally consistent after import', async () => {
    const a = makeStore()
    await importProjectContent(cleanBundle(), 'uidA', a.store)

    const da = a.cap.dashboards[0] as { id: string; filterConfig: { scope: { tabIds: string[] } }[] }
    const ta = a.cap.tabs as { id: string; dashboardId: string; parentTabId: string | null }[]
    const wa = a.cap.widgets[0] as { id: string; tabId: string }

    // The widget sits on the root tab, the sub-tab points at its parent, the filter
    // scope references the root tab, and every tab belongs to the dashboard.
    expect(wa.tabId).toBe(ta[0].id)
    expect(ta[1].parentTabId).toBe(ta[0].id)
    expect(da.filterConfig[0].scope.tabIds).toEqual([ta[0].id])
    expect(ta.every(t => t.dashboardId === da.id)).toBe(true)
  })

  // A legacy export (UUID ids, project.uid, no content keys) must still import via
  // the mapId path — the change is a tolerant per-record read, not a migration.
  it('still imports a legacy UUID-based bundle (mapId path)', async () => {
    const legacy: ParsedProjectZip = {
      project: { uid: 'p1', name: { en: 'P' } } as unknown as ParsedProjectZip['project'],
      ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
      dashboards: [{
        id: 'dash-uuid', projectUid: 'p1', name: { en: 'D' }, gridV: 2,
        filterConfig: [{
          id: 'f-uuid', datasetFileId: 'ds-uuid', columnId: 'c1', columnName: 'sex',
          type: 'categorical', inputType: 'multi-select',
          scope: { type: 'tabs', tabIds: ['tab-uuid'] },
        }],
      } as unknown as ParsedProjectZip['dashboards'][number]],
      dashboardTabs: [
        { id: 'tab-uuid', dashboardId: 'dash-uuid', name: { en: 'T' }, displayOrder: 0, parentTabId: null } as unknown as ParsedProjectZip['dashboardTabs'][number],
        { id: 'sub-uuid', dashboardId: 'dash-uuid', name: { en: 'S' }, displayOrder: 1, parentTabId: 'tab-uuid' } as unknown as ParsedProjectZip['dashboardTabs'][number],
      ],
      dashboardWidgets: [
        { id: 'w-uuid', tabId: 'tab-uuid', name: { en: 'W' }, layout: { x: 0, y: 0, w: 4, h: 2 }, source: { type: 'inline', language: 'sql', code: '', config: {} } } as unknown as ParsedProjectZip['dashboardWidgets'][number],
      ],
      datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
      attachmentsMeta: [], attachmentBlobs: new Map(),
    }

    const { store, cap } = makeStore()
    await importProjectContent(legacy, 'p1', store)

    const d = cap.dashboards[0] as { id: string; filterConfig: { id: string; scope: { tabIds: string[] } }[] }
    const tabs = cap.tabs as { id: string; dashboardId: string; parentTabId: string | null }[]
    const w = cap.widgets[0] as { id: string; tabId: string }
    // All ids remapped through mapId(projectUid, oldId) — deterministic, non-empty,
    // and the FK relationships still hold after remapping.
    expect(d.id).toBeTruthy()
    expect(tabs[0].dashboardId).toBe(d.id)
    expect(tabs[1].parentTabId).toBe(tabs[0].id)
    expect(w.tabId).toBe(tabs[0].id)
    expect(d.filterConfig[0].scope.tabIds).toEqual([tabs[0].id])
    expect(d.filterConfig[0].id).toBeTruthy()
  })
})

// An entity's readme and license travel as README.md / LICENSE.md next to its
// metadata (the convention git hosts recognise), never inside the JSON — and they
// must come back on import, or documenting a pipeline would be lost on the first
// export/import round-trip.
describe('ETL pipeline docs — readme, license and attachments round-trip', () => {
  const PIPELINE = (over: Record<string, unknown> = {}) => ({
    id: 'etl-1', entityId: 'my-etl', workspaceId: 'ws-1',
    name: { en: 'My ETL' }, description: {},
    sourceDataSourceId: 'ds-1', status: 'draft' as const,
    readme: { en: '# My ETL\n\n<img src="attachments/diagram.png" />', fr: '# Mon ETL' },
    license: { id: 'MIT' as const, text: 'MIT License\n\nCopyright (c) 2026 CHU\n' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  })
  const ATTACHMENT = {
    id: 'att-1', ownerType: 'etl-pipeline' as const, ownerId: 'etl-1', workspaceId: 'ws-1',
    fileName: 'diagram.png', mimeType: 'image/png', fileSize: 4,
    data: new Uint8Array([1, 2, 3, 4]).buffer, createdAt: '2026-01-01T00:00:00.000Z',
  }

  const storeWith = (attachments: unknown[], files: unknown[] = []) => ({
    etlFiles: { getByPipeline: async () => files },
    readmeAttachments: { getByOwner: async () => attachments },
  }) as unknown as Storage

  it('writes README.md, LICENSE.md and attachments/, and strips them from _pipeline.json', async () => {
    const zip = new JSZip()
    await buildEtlPipelineFolder(zip, '', PIPELINE(), storeWith([ATTACHMENT]))

    expect(await zip.files['README.md'].async('string')).toContain('# My ETL')
    expect(await zip.files['README.fr.md'].async('string')).toBe('# Mon ETL')
    expect(await zip.files['LICENSE.md'].async('string')).toContain('MIT License')
    expect(zip.files['attachments/att-1-diagram.png']).toBeDefined()

    const meta = JSON.parse(await zip.files['entity.json'].async('string'))
    expect(meta.readme).toBeUndefined()
    // The license id stays in the JSON so it round-trips without parsing legalese;
    // the text is only in LICENSE.md.
    expect(meta.license).toEqual({ id: 'MIT' })

    // The attachments manifest is portable: no instance-local owner fields.
    const attMeta = JSON.parse(await zip.files['attachments/_meta.json'].async('string'))
    expect(attMeta).toEqual([{
      id: 'att-1', fileName: 'diagram.png', mimeType: 'image/png',
      fileSize: 4, createdAt: '2026-01-01T00:00:00.000Z',
    }])
  })

  it('parseWorkspaceZip folds the files back onto the pipeline', async () => {
    const zip = new JSZip()
    zip.file('workspace.json', JSON.stringify({ id: 'ws-1', name: { en: 'W' } }))
    await buildEtlPipelineFolder(zip, 'etl/my-etl/', PIPELINE(), storeWith([ATTACHMENT]))
    const file = await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File

    const parsed = await parseWorkspaceZip(file)
    const entry = parsed!.etlPipelines.find((p) => p.pipeline.entityId === 'my-etl')!
    expect(entry.pipeline.readme).toEqual({ en: expect.stringContaining('# My ETL'), fr: '# Mon ETL' })
    expect(entry.pipeline.license).toEqual({ id: 'MIT', text: expect.stringContaining('MIT License') })
    expect(entry.attachments!.meta.map((m) => m.fileName)).toEqual(['diagram.png'])
    expect(entry.attachments!.blobs.get('att-1')).toBeDefined()
  })

  it('applyClonedEntity restores the docs of a cloned pipeline repo', async () => {
    const calls: Record<string, unknown[][]> = {}
    const rec = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return Promise.resolve() }
    const store = new Proxy({}, {
      get: (_t, prop) => {
        switch (prop) {
          case 'etlPipelines': return { update: rec('etl.update') }
          case 'readmeAttachments': return { deleteByOwner: rec('att.deleteByOwner'), create: rec('att.create') }
          default: return new Proxy({}, { get: () => async () => [] })
        }
      },
    }) as unknown as Storage

    const repo = new JSZip()
    await buildEtlPipelineFolder(repo, '', PIPELINE(), storeWith([ATTACHMENT]))
    expect(await applyClonedEntity(repo, 'etl-pipeline', 'etl-target', store, 'ws-2')).toBe(true)

    const changes = calls['etl.update']![0][1] as { readme?: unknown; license?: unknown }
    expect(changes.readme).toEqual({ en: expect.stringContaining('# My ETL'), fr: '# Mon ETL' })
    expect(changes.license).toEqual({ id: 'MIT', text: expect.stringContaining('MIT License') })
    // Re-cloning must not stack duplicate images.
    expect(calls['att.deleteByOwner']![0]).toEqual(['etl-pipeline', 'etl-target'])
    expect(calls['att.create']![0][0]).toMatchObject({
      fileName: 'diagram.png', ownerType: 'etl-pipeline', ownerId: 'etl-target', workspaceId: 'ws-2',
    })
  })

  it('emits no docs files for a pipeline without readme or license', async () => {
    const zip = new JSZip()
    await buildEtlPipelineFolder(zip, '', PIPELINE({ readme: undefined, license: undefined }), storeWith([]))
    expect(zip.files['README.md']).toBeUndefined()
    expect(zip.files['LICENSE.md']).toBeUndefined()
    expect(zip.files['attachments/_meta.json']).toBeUndefined()
  })

  // _tree.json must describe the repo, not the machine. An unmarked data file is
  // gitignored, so listing it made every pull offer a phantom incoming change for
  // a file that was never committed and never could be.
  describe('_tree.json lists only what the repo actually carries', () => {
    const FILES = [
      { id: 'd1', pipelineId: 'etl-1', name: 'mapping', type: 'folder' as const, parentId: null, order: -2, createdAt: 'T0' },
      { id: 'f1', pipelineId: 'etl-1', name: 'source_to_concept_map.csv', type: 'file' as const, parentId: 'd1', content: 'a,b\n1,2\n', order: 0, createdAt: 'T0' },
      { id: 'f2', pipelineId: 'etl-1', name: '00_vocabulary.sql', type: 'file' as const, parentId: null, content: 'SELECT 1;', order: -1, createdAt: 'T0' },
    ]
    const treeOf = async (zip: JSZip) =>
      (JSON.parse(await zip.files['scripts/_tree.json'].async('string')) as { path: string }[]).map((n) => n.path)

    it('omits an UNMARKED data file — the phantom pull item', async () => {
      const zip = new JSZip()
      await buildEtlPipelineFolder(zip, '', PIPELINE(), storeWith([], FILES))
      const paths = await treeOf(zip)
      expect(paths).not.toContain('mapping/source_to_concept_map.csv')
      expect(paths).toContain('00_vocabulary.sql')
      // Not written either, and gitignored — the tree now agrees with both.
      expect(zip.files['mapping/source_to_concept_map.csv']).toBeUndefined()
      expect(await zip.files['.gitignore'].async('string')).toContain('**/*.csv')
    })

    it('keeps a data file the user MARKED for versioning, and un-ignores it', async () => {
      const zip = new JSZip()
      await buildEtlPipelineFolder(
        zip, '',
        PIPELINE({ config: { versionedDataFiles: ['mapping/source_to_concept_map.csv'] } }),
        storeWith([], FILES),
      )
      expect(await treeOf(zip)).toContain('mapping/source_to_concept_map.csv')
      expect(zip.files['mapping/source_to_concept_map.csv']).toBeDefined()
      expect(await zip.files['.gitignore'].async('string'))
        .toContain('!mapping/source_to_concept_map.csv')
    })

    it('still omits an excluded CODE file', async () => {
      const zip = new JSZip()
      await buildEtlPipelineFolder(
        zip, '',
        PIPELINE({ config: { excludedFiles: ['00_vocabulary.sql'] } }),
        storeWith([], FILES),
      )
      const paths = await treeOf(zip)
      expect(paths).not.toContain('00_vocabulary.sql')
      expect(zip.files['00_vocabulary.sql']).toBeUndefined()
    })

    it('agrees with isVersioned, the rule the versioning UI uses', async () => {
      // The export inlines the rule to avoid an import cycle; if the two ever
      // disagree the tree and the UI would describe different repos.
      const config = { versionedDataFiles: ['mapping/source_to_concept_map.csv'] }
      const zip = new JSZip()
      await buildEtlPipelineFolder(zip, '', PIPELINE({ config }), storeWith([], FILES))
      const paths = new Set(await treeOf(zip))
      for (const p of ['mapping/source_to_concept_map.csv', '00_vocabulary.sql']) {
        expect(paths.has(p), p).toBe(isVersioned(p, config))
      }
    })
  })
})

// A project's and a workspace's license travels as LICENSE.md (the file git hosts
// recognise); only its id stays in the JSON. Without the import side, picking a
// license would be silently lost on the first export/import round-trip.
describe('project / workspace license — LICENSE.md round-trip', () => {
  it('parseProjectZip recombines the license id from project.json with the file text', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      uid: 'p1', name: { en: 'P' }, description: {}, projectId: 'p',
      license: { id: 'GPL-3.0' },
    }))
    zip.file('LICENSE.md', 'GNU GENERAL PUBLIC LICENSE\nVersion 3\n')
    const parsed = await parseProjectZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed!.project.license).toEqual({
      id: 'GPL-3.0', text: 'GNU GENERAL PUBLIC LICENSE\nVersion 3\n',
    })
  })

  it('treats a LICENSE.md with no metadata as a custom license', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'p1', name: { en: 'P' }, description: {}, projectId: 'p' }))
    zip.file('LICENSE.md', 'Internal hospital use only.\n')
    const parsed = await parseProjectZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed!.project.license).toEqual({ id: 'custom', text: 'Internal hospital use only.\n' })
  })

  it('parseWorkspaceZip reads the workspace license and its readme images', async () => {
    const zip = new JSZip()
    zip.file('workspace.json', JSON.stringify({
      id: 'ws-1', name: { en: 'W' }, license: { id: 'custom', name: 'House rules' },
    }))
    zip.file('LICENSE.md', 'Ask before reusing.\n')
    zip.file('attachments/_meta.json', JSON.stringify([{
      id: 'att-9', fileName: 'logo.png', mimeType: 'image/png', fileSize: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    }]))
    zip.file('attachments/att-9-logo.png', new Uint8Array([7, 8]))

    const parsed = await parseWorkspaceZip(await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File)
    expect(parsed!.workspace.license).toEqual({
      id: 'custom', name: 'House rules', text: 'Ask before reusing.\n',
    })
    expect(parsed!.workspaceAttachments!.meta.map((m) => m.fileName)).toEqual(['logo.png'])
    expect(parsed!.workspaceAttachments!.blobs.get('att-9')).toBeDefined()
  })
})

// A tree entry with no blob behind it is normal: data files are gitignored unless
// marked for versioning. Importing them anyway created empty files the repo never
// held, and the user then ran a pipeline against a phantom mapping table.
describe('reassemblePresetMapping', () => {
  // `SchemaMapping.presetLabel` is REQUIRED and a database copies the mapping into
  // its own row, where it is that database's only record of which schema it uses.
  // So the preset's export drops it (the root carries `name`) and the reader must
  // put it back — otherwise every imported preset loses its label.
  it('restores presetLabel from the root name, on the split layout', () => {
    const meta = { name: { en: 'OMOP CDM 5.4' }, description: { en: 'A model' } }
    const mapping = reassemblePresetMapping(meta, { presetId: 'omop', tables: {} } as never)
    expect(mapping.presetLabel).toEqual({ en: 'OMOP CDM 5.4' })
    expect(mapping.description).toEqual({ en: 'A model' })
    expect(mapping.presetId).toBe('omop')
  })

  it('still reads a preset published before the split, with mapping inline', () => {
    const meta = {
      mapping: { presetId: 'omop', presetLabel: { en: 'Old label' }, tables: {} },
    }
    const mapping = reassemblePresetMapping(meta as never, undefined)
    expect(mapping.presetLabel).toEqual({ en: 'Old label' })
    expect(mapping.presetId).toBe('omop')
  })

  it('prefers what the mapping file carries over the root', () => {
    // A hand-authored tree may legitimately still carry the label inside; taking
    // the root unconditionally would silently overwrite it.
    const meta = { name: { en: 'Root' } }
    const mapping = reassemblePresetMapping(meta, { presetLabel: { en: 'Inner' } } as never)
    expect(mapping.presetLabel).toEqual({ en: 'Inner' })
  })

  it('never leaves presetLabel undefined, since the type requires it', () => {
    expect(reassemblePresetMapping({}, undefined).presetLabel).toEqual({ en: '', fr: '' })
  })
})

describe('reconstructTreeFiles', () => {
  const tree = [
    { path: '00_vocabulary.sql', type: 'file' },
    { path: 'mapping', type: 'folder' },
    { path: 'mapping/source_to_concept_map.csv', type: 'file' },
  ]

  it('drops a file the tree declares but the ZIP does not carry', () => {
    const nodes = reconstructTreeFiles(tree, { '00_vocabulary.sql': 'SELECT 1;' })
    expect(nodes.map((n) => n.path)).toEqual(['00_vocabulary.sql', 'mapping'])
  })

  it('keeps the file once the repo carries it', () => {
    const nodes = reconstructTreeFiles(tree, {
      '00_vocabulary.sql': 'SELECT 1;',
      'mapping/source_to_concept_map.csv': 'source_code,target_concept_id\nA,1\n',
    })
    expect(nodes.map((n) => n.path)).toEqual([
      '00_vocabulary.sql', 'mapping', 'mapping/source_to_concept_map.csv',
    ])
  })

  it('keeps legacy nodes whose content is inline', () => {
    // files.json carried content on the node itself, with no raw file beside it.
    const legacy = [{ id: 'f1', name: 'a.sql', type: 'file', content: 'SELECT 2;' }]
    expect(reconstructTreeFiles(legacy, {})).toEqual([
      expect.objectContaining({ path: 'a.sql', content: 'SELECT 2;' }),
    ])
  })

  it('re-serialises a JSON file, which parseImportZip returns parsed', () => {
    const nodes = reconstructTreeFiles([{ path: 'conf.json', type: 'file' }], {
      'conf.json': { a: 1 },
    })
    expect(nodes[0].content).toBe('{\n  "a": 1\n}')
  })

  it('finds a file under the scripts/ prefix, keeping the tree path bare', () => {
    // The tree stays entity-relative; only the physical file moved. Reading it at
    // the bare path found nothing, which emptied every duplicated pipeline.
    const nodes = reconstructTreeFiles(
      [{ path: 'load.py', type: 'file' }], { 'scripts/load.py': 'print(1)' }, 'scripts/',
    )
    expect(nodes[0]).toMatchObject({ path: 'load.py', content: 'print(1)' })
  })

  it('falls back to the bare path, so a mapping/ file still resolves', () => {
    // mapping/ does NOT move under scripts/, so one prefixed call must read both.
    const nodes = reconstructTreeFiles(
      [{ path: 'mapping/v.csv', type: 'file' }], { 'mapping/v.csv': 'a,b\n' }, 'scripts/',
    )
    expect(nodes[0]).toMatchObject({ path: 'mapping/v.csv', content: 'a,b\n' })
  })
})

describe('readImportedManifest / readImportedTree', () => {
  it('reads the current names', () => {
    const parsed = { 'entity.json': { id: 'p1' }, 'scripts/_tree.json': [{ path: 'a.py' }] }
    expect(readImportedManifest(parsed, 'etl-pipeline')).toEqual({ id: 'p1' })
    expect(readImportedTree(parsed)).toEqual({ tree: [{ path: 'a.py' }], filePrefix: 'scripts/' })
  })

  it('still reads a repo published before the rename', () => {
    const parsed = { '_pipeline.json': { id: 'p1' }, '_tree.json': [{ path: 'a.py' }] }
    expect(readImportedManifest(parsed, 'etl-pipeline')).toEqual({ id: 'p1' })
    expect(readImportedTree(parsed)).toEqual({ tree: [{ path: 'a.py' }], filePrefix: '' })
  })

  it('still reads the oldest layout, via the legacy names', () => {
    const parsed = { 'pipeline.json': { id: 'p1' }, 'files.json': [{ id: 'f1' }] }
    expect(readImportedManifest(parsed, 'etl-pipeline', 'pipeline.json')).toEqual({ id: 'p1' })
    expect(readImportedTree(parsed, 'files.json')).toEqual({ tree: [{ id: 'f1' }], filePrefix: '' })
  })

  it('returns undefined rather than guessing when nothing matches', () => {
    expect(readImportedManifest({}, 'etl-pipeline')).toBeUndefined()
    expect(readImportedTree({})).toEqual({ tree: undefined, filePrefix: '' })
  })
})

// Concept lists are project-scoped and must survive an export/import round-trip
// (git versioning depends on it). They are also an OPTIONAL section: a ZIP made
// before the feature existed has no concept-lists/ folder, and importing it must
// not throw.
describe('parseProjectZip — concept lists', () => {
  const makeZip = async (withLists: boolean) => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({
      uid: 'p1', name: { en: 'P' }, projectId: 'p', workspaceId: 'w', ownerId: 1,
    }))
    if (withLists) {
      zip.file('concept-lists/my-list.json', JSON.stringify({
        id: 'l1',
        projectUid: 'p1',
        name: { en: 'My list', fr: 'Ma liste' },
        description: { en: 'Phenotype' },
        items: [{ conceptId: 3027018, conceptName: 'Heart rate', vocabularyId: 'LOINC', conceptCode: '8867-4' }],
        version: '0.1.0',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }))
    }
    return await zip.generateAsync({ type: 'arraybuffer' }) as unknown as File
  }

  it('round-trips a list with both languages and its items', async () => {
    const parsed = await parseProjectZip(await makeZip(true))
    expect(parsed).not.toBeNull()
    expect(parsed!.conceptLists).toHaveLength(1)
    const list = parsed!.conceptLists[0]
    expect(list.name.en).toBe('My list')
    expect(list.name.fr).toBe('Ma liste')
    expect(list.items).toHaveLength(1)
    expect(list.items[0].conceptId).toBe(3027018)
    expect(list.items[0].conceptCode).toBe('8867-4')
  })

  it('yields an empty list for a ZIP that predates the feature', async () => {
    const parsed = await parseProjectZip(await makeZip(false))
    expect(parsed!.conceptLists).toEqual([])
  })
})

/**
 * Export ordering must not depend on edit history: two instances holding the
 * same mapping have to emit the same bytes, or git shows a diff where nothing
 * changed. Mirrored by _canonical_schema_mapping in workspace_export_assemble.py.
 */
describe('canonicalSchemaMapping orders event tables deterministically', () => {
  const messy = {
    eventTables: {
      Zeta: { dateColumn: 'd', table: 'z', conceptIdColumn: 'c' },
      Alpha: { conceptIdColumn: 'c', table: 'a', endDateColumn: 'e', dateColumn: 'd' },
    },
  }

  it('is independent of the order the fields were written in', () => {
    const a = canonicalSchemaMapping({
      eventTables: { T: { table: 't', dateColumn: 'd', conceptIdColumn: 'c' } },
    })
    const b = canonicalSchemaMapping({
      eventTables: { T: { conceptIdColumn: 'c', table: 't', dateColumn: 'd' } },
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('keeps the end date beside the date rather than sorting them apart', () => {
    const out = canonicalSchemaMapping(messy) as { eventTables: Record<string, object> }
    const keys = Object.keys(out.eventTables.Alpha)
    expect(keys.indexOf('endDateColumn')).toBe(keys.indexOf('dateColumn') + 1)
  })

  it('sorts the table labels, which are a user-keyed map', () => {
    const out = canonicalSchemaMapping(messy) as { eventTables: Record<string, object> }
    expect(Object.keys(out.eventTables)).toEqual(['Alpha', 'Zeta'])
  })

  it('passes a null or non-object entry through, like the server twin', () => {
    // _canonical_schema_mapping guards `isinstance(et, dict)`. Throwing here
    // instead meant a hand-edited or partially-written preset exported from the
    // server and not at all from the browser — the exact divergence the
    // deterministic ordering exists to prevent.
    const out = canonicalSchemaMapping({
      eventTables: { A: null, B: 'oops', C: { table: 'c', conceptIdColumn: 'i', dateColumn: 'd' } },
    }) as { eventTables: Record<string, unknown> }
    expect(out.eventTables.A).toBeNull()
    expect(out.eventTables.B).toBe('oops')
    expect(Object.keys(out.eventTables.C as object)).toContain('table')
  })

  it('appends unknown fields sorted, so a new one is stable before it is placed', () => {
    const out = canonicalSchemaMapping({
      eventTables: { T: { zzz: 1, table: 't', aaa: 2 } },
    }) as { eventTables: Record<string, object> }
    expect(Object.keys(out.eventTables.T)).toEqual(['table', 'aaa', 'zzz'])
  })

  it('leaves a mapping with no event tables alone', () => {
    const m = { presetId: 'x' }
    expect(canonicalSchemaMapping(m)).toBe(m)
  })
})

describe('projectSlug / sameProjectSlug', () => {
  // A project's readable slug is `entityId` now and was `projectId` before. Both
  // names hold the same value, and a published repo may carry either — so import
  // matching has to see across them or an overwrite mints a duplicate instead.
  it('reads either name, preferring the current one', () => {
    expect(projectSlug({ entityId: 'icu-demo' })).toBe('icu-demo')
    expect(projectSlug({ projectId: 'icu-demo' })).toBe('icu-demo')
    expect(projectSlug({ entityId: 'new', projectId: 'old' })).toBe('new')
    expect(projectSlug({})).toBeUndefined()
  })

  it('matches a repo published under the old name against a row stored under the new', () => {
    expect(sameProjectSlug({ entityId: 'icu-demo' }, { projectId: 'icu-demo' })).toBe(true)
    expect(sameProjectSlug({ projectId: 'icu-demo' }, { entityId: 'icu-demo' })).toBe(true)
    expect(sameProjectSlug({ entityId: 'a' }, { entityId: 'b' })).toBe(false)
  })

  it('never matches two projects that both lack a slug', () => {
    // Otherwise every slugless project would collide with every other one, and an
    // import would silently overwrite an unrelated row.
    expect(sameProjectSlug({}, {})).toBe(false)
  })
})
