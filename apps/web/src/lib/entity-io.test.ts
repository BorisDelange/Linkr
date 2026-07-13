import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { slugify, parseCsvLine, parseCsvToDatasetData, parseProjectZip, parseWorkspaceZip, deleteProjectData, datasetToCsv, importProjectContent, stripInstanceFields, dropForeignAuthorId, attachEntityOrganization } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import type { DatasetFile } from '@/types'
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
  it('drops owner, local author id, placement, git link, catalog/org and timestamps', () => {
    const meta = {
      uid: 'p1', name: { en: 'P' }, config: {},
      ownerId: 7, createdById: 3, workspaceId: 'ws-1',
      gitRemoteConfig: { url: 'https://x/y.git', branch: 'main', authToken: 'secret' },
      gitUrl: 'https://x/y.git', catalogVisibility: 'public',
      organization: { id: 'o' }, organizationId: 'o',
      createdAt: '2020', updatedAt: '2021',
    }
    const out = stripInstanceFields(meta)
    expect(out).toEqual({ uid: 'p1', name: { en: 'P' }, config: {} })
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
    const meta = { uid: 'p1', name: { en: 'P' }, description: { en: 'D' }, badges: [{ id: 'b' }], status: 'active' }
    expect(stripInstanceFields(meta)).toEqual(meta)
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
    const store = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'dashboardWidgets') return { create: widgetCreate }
        if (prop === 'datasetFiles') return { create: datasetFileCreate }
        return new Proxy({}, { get: () => async () => {} })
      },
    }) as unknown as Storage
    return { store, widgetCreate, datasetFileCreate }
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
