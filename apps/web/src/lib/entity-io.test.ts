import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { slugify, parseCsvLine, parseCsvToDatasetData, parseProjectZip, deleteProjectData, datasetToCsv, importProjectContent } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import type { DatasetFile } from '@/types'
import type { Storage } from '@/lib/storage'

const serverMode = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => serverMode.value }))
const importDatasetOnServer = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer }))

// slugify produces filesystem-safe names for ZIP entries and folders.
// A bad slug means a file overwrites another or fails to write → data loss.
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
