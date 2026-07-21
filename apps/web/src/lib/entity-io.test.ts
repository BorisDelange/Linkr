import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { slugify, parseCsvLine, parseCsvToDatasetData, parseProjectZip, parseWorkspaceZip, deleteProjectData, datasetToCsv, importProjectContent, stripInstanceFields, dropForeignAuthorId, attachEntityOrganization, buildWorkspaceZip, buildUserPluginZip, collectGitLinkedEntities, applyClonedEntity } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
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
  it('keeps id + createdAt, drops updatedAt from the attached org', async () => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify({ uid: 'p1', name: { en: 'P' } }))
    const entity = {
      organization: {
        id: 'org-7', name: { en: 'Acme' },
        createdAt: '2020-01-01T00:00:00Z', updatedAt: '2021-02-02T00:00:00Z',
      },
    }
    // storage is unused when entity.organization is present.
    await attachEntityOrganization(zip, 'project.json', entity, {} as never)
    const written = JSON.parse(await zip.file('project.json')!.async('string'))
    expect(written.organization.id).toBe('org-7')
    expect(written.organization.createdAt).toBe('2020-01-01T00:00:00Z')
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

// A standalone entity (SQL collection, ETL, mapping project…) has no org link of
// its own — it inherits the org managed at its parent workspace. Export must resolve
// workspaceId → workspace.organizationId → the org, then inline it as an
// `organization` field on the entity's own metadata JSON (single-entity export:
// one org, embedded for a self-sufficient, human-readable file).
describe('attachEntityOrganization — inlines inherited org into entity meta', () => {
  const makeStore = (workspace: unknown, org: unknown) => ({
    workspaces: { getById: async (id: string) => ((workspace as { id?: string })?.id === id ? workspace : undefined) },
    organizations: { getById: async (id: string) => ((org as { id?: string })?.id === id ? org : undefined) },
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
  }) as unknown as Storage

  const readMeta = async (blob: Blob) => {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    return JSON.parse(await zip.files['_plugin.json'].async('string'))
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
    ideFiles: [], pipelines: [], cohorts: [], connections: [],
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
    const marker = zip.files['catalogs/my-catalog/_catalog.json']
    expect(marker).toBeDefined()
    expect(JSON.parse(await marker.async('string')).id).toBe('cat-1')
    // No flat form when linked.
    expect(zip.files['catalogs/my-catalog.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'data-catalog', id: 'cat-1', folder: 'my-catalog', url: GIT.url, branch: 'main' })
  })

  it('writes a folder marker holding { ruleSet, checks } + git-links entry for a linked dq-rule-set', async () => {
    const zip = await exportZip({ ruleSets: [RULESET({ gitRemoteConfig: GIT })], checks: [CHECK()] })
    const marker = zip.files['data-quality/my-ruleset/_ruleset.json']
    expect(marker).toBeDefined()
    const bundle = JSON.parse(await marker.async('string'))
    expect(bundle.ruleSet.id).toBe('rs-1')
    expect(bundle.checks).toHaveLength(1)
    expect(zip.files['data-quality/my-ruleset.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'dq-rule-set', id: 'rs-1', folder: 'my-ruleset', url: GIT.url, branch: 'main' })
  })

  it('writes a folder marker + git-links entry for a linked schema-preset', async () => {
    const zip = await exportZip({ presets: [PRESET({ gitRemoteConfig: GIT })] })
    const marker = zip.files['schemas/my-preset/_schema.json']
    expect(marker).toBeDefined()
    expect(JSON.parse(await marker.async('string')).presetId).toBe('my-preset')
    expect(zip.files['schemas/my-preset.json']).toBeUndefined()
    const { links } = await readGitLinks(zip)
    expect(links).toContainEqual({ type: 'schema-preset', id: 'my-preset', folder: 'my-preset', url: GIT.url, branch: 'main' })
  })

  it('keeps the flat form (no marker, no git-links) when the entity is NOT linked', async () => {
    const zip = await exportZip({
      catalogs: [CATALOG()], ruleSets: [RULESET()], checks: [CHECK()], presets: [PRESET()],
    })
    expect(zip.files['catalogs/my-catalog.json']).toBeDefined()
    expect(zip.files['catalogs/my-catalog/_catalog.json']).toBeUndefined()
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
    expect(linked.find(l => l.type === 'data-catalog')).toMatchObject({ id: 'cat-1', url: GIT.url, branch: 'main' })
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
          case 'schemaPresets': return { save: rec('preset.save') }
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

    const spZip = new JSZip(); spZip.file('preset.json', JSON.stringify(PRESET()))
    expect(await applyClonedEntity(spZip, 'schema-preset', 'preset-target', store)).toBe(true)
    expect((calls['preset.save']![0][0] as { presetId: string }).presetId).toBe('preset-target')
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

  it('applyClonedEntity returns false when the cloned repo lacks the expected marker', async () => {
    const store = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => {} }) }) as unknown as Storage
    expect(await applyClonedEntity(new JSZip(), 'data-catalog', 'x', store)).toBe(false)
    expect(await applyClonedEntity(new JSZip(), 'dq-rule-set', 'x', store)).toBe(false)
    expect(await applyClonedEntity(new JSZip(), 'schema-preset', 'x', store)).toBe(false)
  })
})

// The git round-trip goal: delete a project + reimport it from git into a fresh
// instance (new project uid) = ZERO diff. Dashboards/tabs/widgets used to churn
// because their ids were UUIDs re-derived from the (regenerated) project uid. A
// git-versioned export now strips those UUIDs and carries CONTENT keys; import
// re-derives the ids from the lineage namespace, so the SAME clean bundle imported
// under two different uids yields byte-identical ids.
describe('§4 uid-independent dashboard ids', () => {
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
    ideFiles: [], pipelines: [], cohorts: [], connections: [],
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

  it('re-derives IDENTICAL ids for the same clean bundle across two different project uids', async () => {
    const a = makeStore()
    const b = makeStore()
    await importProjectContent(cleanBundle(), 'uidA', a.store)
    await importProjectContent(cleanBundle(), 'uidB', b.store)

    const da = a.cap.dashboards[0] as { id: string; filterConfig: { id: string; scope: { tabIds: string[] } }[] }
    const db = b.cap.dashboards[0] as { id: string; filterConfig: { id: string; scope: { tabIds: string[] } }[] }
    const ta = a.cap.tabs as { id: string; dashboardId: string; parentTabId: string | null }[]
    const tb = b.cap.tabs as { id: string; dashboardId: string; parentTabId: string | null }[]
    const wa = a.cap.widgets[0] as { id: string; tabId: string }
    const wb = b.cap.widgets[0] as { id: string; tabId: string }

    // Zero-diff: every derived id matches across the two different uids.
    expect(da.id).toBe(db.id)
    expect(da.filterConfig[0].id).toBe(db.filterConfig[0].id)
    expect(da.filterConfig[0].scope.tabIds).toEqual(db.filterConfig[0].scope.tabIds)
    expect(ta.map(t => t.id)).toEqual(tb.map(t => t.id))
    expect(ta.map(t => t.dashboardId)).toEqual(tb.map(t => t.dashboardId))
    expect(ta.map(t => t.parentTabId)).toEqual(tb.map(t => t.parentTabId))
    expect(wa.id).toBe(wb.id)
    expect(wa.tabId).toBe(wb.tabId)

    // The relationships are internally consistent (not just equal to each other):
    // the widget sits on the root tab, the sub-tab points at its parent, the
    // filter scope references the root tab, and every tab belongs to the dashboard.
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
      ideFiles: [], pipelines: [], cohorts: [], connections: [],
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
