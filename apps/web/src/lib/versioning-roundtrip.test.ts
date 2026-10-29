/**
 * The precondition of the 3-way pull (docs/planning/collaborative-versioning-plan.md
 * §9.2): applying an entity's own export onto it changes nothing.
 *
 * Per versioned kind, on a real IndexedDB storage (fake-indexeddb): the golden
 * export tree is applied onto a stub row (as a git import does), exported (A),
 * applied again in place (as a pull would), exported again (B). A and B must be
 * byte-identical and every child must keep its id — otherwise a pull reports
 * phantom changes, or leaves widgets pointing at a dataset that no longer exists.
 */
import 'fake-indexeddb/auto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { beforeAll, describe, expect, it } from 'vitest'
import { createIDBStorage } from './storage/idb-storage'
import { initStorage, type Storage } from './storage'
import {
  applyClonedEntity,
  buildDataCatalogZip,
  buildDqRuleSetZip,
  buildEtlPipelineZip,
  buildProjectZip,
  buildSchemaPresetZip,
  buildSqlCollectionZip,
  type GitLinkedEntity,
} from './entity-io'

// JSZip reads a Blob through FileReader, which Node lacks.
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | null = null
    onload: ((e: { target: NodeFileReader }) => void) | null = null
    onerror: ((e: { target: { error: unknown } }) => void) | null = null
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (buf) => { this.result = buf; this.onload?.({ target: this }) },
        (error) => this.onerror?.({ target: { error } }),
      )
    }
  }
  ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
}

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'export-golden')
const WS = 'ws-roundtrip'
const NOW = '2026-01-01T00:00:00.000Z'

function goldenZip(kind: string): JSZip {
  const root = join(GOLDEN, kind, 'expected')
  const zip = new JSZip()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else zip.file(relative(root, full), readFileSync(full))
    }
  }
  walk(root)
  return zip
}

async function treeOf(blob: Blob | undefined | null): Promise<Record<string, string>> {
  expect(blob, 'the export built nothing').toBeTruthy()
  const zip = await JSZip.loadAsync(await blob!.arrayBuffer())
  const out: Record<string, string> = {}
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[path] = await entry.async('base64')
  }
  return out
}

async function zipOf(tree: Record<string, string>): Promise<JSZip> {
  const zip = new JSZip()
  for (const [path, b64] of Object.entries(tree)) zip.file(path, b64, { base64: true })
  return zip
}

/** Every child row's id, by store, so an id that moved on re-apply shows up. */
async function childIds(storage: Storage, kind: Kind, id: string): Promise<Record<string, string[]>> {
  const ids = (rows: { id?: string; uid?: string }[]) => rows.map((r) => r.id ?? r.uid ?? '').sort()
  switch (kind.type) {
    case 'project':
      return {
        dashboards: ids(await storage.dashboards.getByProject(id)),
        files: ids(await storage.ideFiles.getByProject(id)),
        datasets: ids(await storage.datasetFiles.getByProject(id)),
        cohorts: ids((await storage.cohorts.getAll()).filter((c) => (c as { projectUid?: string }).projectUid === id)),
      }
    case 'sql-collection':
      return { files: ids(await storage.sqlScriptFiles.getByCollection(id)) }
    case 'etl-pipeline':
      return { files: ids(await storage.etlFiles.getByPipeline(id)) }
    case 'dq-rule-set':
      return { checks: ids(await storage.dqCustomChecks.getByRuleSet(id)) }
    default:
      return {}
  }
}

interface Kind {
  golden: string
  type: GitLinkedEntity['type']
  stub: (storage: Storage, id: string) => Promise<void>
  build: (storage: Storage, id: string) => Promise<Blob | undefined>
}

const KINDS: Kind[] = [
  {
    golden: 'project', type: 'project',
    stub: (s, id) => s.projects.create({ uid: id, workspaceId: WS, name: { en: 'stub' }, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildProjectZip(id, s))?.blob,
  },
  {
    golden: 'sql-collection', type: 'sql-collection',
    stub: (s, id) => s.sqlScriptCollections.create({ id, workspaceId: WS, name: { en: 'stub' }, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildSqlCollectionZip(id, s))?.blob,
  },
  {
    golden: 'etl-pipeline', type: 'etl-pipeline',
    stub: (s, id) => s.etlPipelines.create({ id, workspaceId: WS, name: { en: 'stub' }, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildEtlPipelineZip(id, s))?.blob,
  },
  {
    golden: 'dq-rule-set', type: 'dq-rule-set',
    stub: (s, id) => s.dqRuleSets.create({ id, workspaceId: WS, name: { en: 'stub' }, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildDqRuleSetZip(id, s))?.blob,
  },
  {
    golden: 'data-catalog', type: 'data-catalog',
    stub: (s, id) => s.dataCatalogs.create({ id, workspaceId: WS, name: { en: 'stub' }, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildDataCatalogZip(id, s))?.blob,
  },
  {
    golden: 'schema-preset', type: 'schema-preset',
    stub: (s, id) => s.schemaPresets.save({ id, presetId: id, workspaceId: WS, mapping: {}, createdAt: NOW, updatedAt: NOW } as never),
    build: async (s, id) => (await buildSchemaPresetZip(id, s))?.blob,
  },
]

/**
 * Kinds whose round trip is known to churn, listed so the suite stays a signal:
 * `it.fails` turns red the day one is fixed, which is when it leaves this list.
 *  - project: on IndexedDB, dataset, connection and attachment ids are re-minted
 *    on import (server mode keys datasets by path); widgets then point elsewhere.
 *  - dq-rule-set: check ids are re-minted on every import and exported with
 *    the checks, in storage order.
 */
const KNOWN_CHURN = new Set(['project', 'dq-rule-set'])

let storage: Storage
beforeAll(() => {
  storage = createIDBStorage()
  initStorage(storage)
})

describe.each(KINDS)('$golden: applying its own export changes nothing', (kind) => {
  const run = KNOWN_CHURN.has(kind.golden) ? it.fails : it
  run('export → apply in place → export is byte-identical, and every child keeps its id', async () => {
    const id = `rt-${kind.golden}`
    await kind.stub(storage, id)
    expect(await applyClonedEntity(goldenZip(kind.golden), kind.type, id, storage, WS)).toEqual({ ok: true })

    const first = await treeOf(await kind.build(storage, id))
    const idsBefore = await childIds(storage, kind, id)

    expect(await applyClonedEntity(await zipOf(first), kind.type, id, storage, WS)).toEqual({ ok: true })
    const second = await treeOf(await kind.build(storage, id))

    expect.soft(Object.keys(second).sort(), 'file list').toEqual(Object.keys(first).sort())
    for (const path of Object.keys(first)) {
      if (!(path in second)) continue
      expect.soft(Buffer.from(second[path], 'base64').toString('utf-8'), path).toBe(Buffer.from(first[path], 'base64').toString('utf-8'))
    }
    expect.soft(await childIds(storage, kind, id), 'child ids').toEqual(idsBefore)
  })
})
