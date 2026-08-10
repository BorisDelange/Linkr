/**
 * Golden format contract for the standalone data catalog git export ZIP.
 *
 * Freezes the exact extracted-file tree `buildDataCatalogZip` produces so the
 * server-side Python builder (workspace_export_assemble.build_data_catalog_tree)
 * can be held to the same bytes. We compare the DECOMPRESSED per-file contents, not
 * the raw .zip container. The fixture (`input.json`) uses the same shapes the
 * frontend Storage yields in server mode, so the TS builder here and the Python
 * twin test (apps/api/tests/test_entity_export_assemble.py) consume identical input
 * and must emit identical bytes.
 *
 * To regenerate after an intentional format change, run BOTH:
 *   (python) GOLDEN_UPDATE=1 pytest tests/test_entity_export_assemble.py
 *   (or)     GOLDEN_UPDATE=1 npx vitest run src/lib/data-catalog-export-golden.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildDataCatalogZip } from './entity-io'
import type { Storage } from '@/lib/storage'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, '__fixtures__', 'export-golden', 'data-catalog')
const EXPECTED_DIR = join(GOLDEN_DIR, 'expected')
const UPDATE = process.env.GOLDEN_UPDATE === '1'

const input = JSON.parse(readFileSync(join(GOLDEN_DIR, 'input.json'), 'utf8')) as {
  catalog: Record<string, unknown>
  workspace: { id: string; organizationId: string }
  organization: Record<string, unknown>
}

const storage = {
  dataCatalogs: { getById: async () => input.catalog },
  readmeAttachments: { getByOwner: async () => [] },
  workspaces: { getById: async () => input.workspace },
  organizations: { getById: async () => input.organization },
} as unknown as Storage

function listExpected(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(dir, p).replace(/\\/g, '/'))
    }
  }
  walk(dir)
  return out
}

async function buildTree(): Promise<Map<string, Uint8Array>> {
  const built = await buildDataCatalogZip('cat-1', storage)
  if (!built) throw new Error('build returned null')
  const zip = await JSZip.loadAsync(await built.blob.arrayBuffer())
  const out = new Map<string, Uint8Array>()
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue
    out.set(f.name, await f.async('uint8array'))
  }
  return out
}

describe('Data catalog export — golden format contract', () => {
  it('reproduces the frozen extracted-file tree byte for byte', async () => {
    const tree = await buildTree()

    if (UPDATE) {
      for (const [path, content] of tree) {
        const dest = join(EXPECTED_DIR, path)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, content)
      }
    }

    const expectedPaths = listExpected(EXPECTED_DIR)
    expect([...tree.keys()].sort()).toEqual(expectedPaths.sort())

    for (const path of expectedPaths) {
      const golden = readFileSync(join(EXPECTED_DIR, path))
      const got = tree.get(path)
      expect(got, `missing ${path}`).toBeDefined()
      expect(Buffer.from(got!).toString('utf8'), `content mismatch for ${path}`).toEqual(golden.toString('utf8'))
    }
  })
})
