import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { slugify, parseCsvLine, parseCsvToDatasetData, parseProjectZip, deleteProjectData } from './entity-io'
import type { DatasetFile } from '@/types'
import type { Storage } from '@/lib/storage'

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
