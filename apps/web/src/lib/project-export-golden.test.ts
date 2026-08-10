/**
 * Golden format contract for the project export ZIP (git variant).
 *
 * Freezes the EXACT extracted-file tree that `buildProjectZip` produces, so the
 * server-side Python builder (apps/api/app/services/project_export.py) can be held
 * to the same bytes (see docs/architecture.md, "Fullstack Storage & Compute"). We compare the
 * DECOMPRESSED per-file contents, not the raw .zip container — git versions the
 * extracted tree, and the container isn't byte-reproducible across JSZip and Python
 * zipfile.
 *
 * The fixture (`input.json`) uses the SAME shapes the frontend's Storage yields in
 * server mode (camelCase, API field order), so the TS builder here and the Python
 * builder's twin test (apps/api/tests/test_project_export.py) consume identical
 * input and must emit identical bytes.
 *
 * To regenerate the golden after an intentional format change, run BOTH:
 *   (python) GOLDEN_UPDATE=1 pytest tests/test_project_export.py
 *   (or)     GOLDEN_UPDATE=1 npx vitest run src/lib/project-export-golden.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildProjectZip } from './entity-io'
import type { Storage } from '@/lib/storage'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, '__fixtures__', 'export-golden', 'project')
const EXPECTED_DIR = join(GOLDEN_DIR, 'expected')
const UPDATE = process.env.GOLDEN_UPDATE === '1'

interface GoldenInput {
  project: Record<string, unknown>
  organization: Record<string, unknown>
  workspace: { id: string; organizationId: string }
  ideFiles: Record<string, unknown>[]
  pipelines: Record<string, unknown>[]
  cohorts: Record<string, unknown>[]
  connections: Record<string, unknown>[]
  dashboards: { dashboard: Record<string, unknown>; tabs: Record<string, unknown>[]; widgets: Record<string, unknown>[] }[]
  datasetFiles: Record<string, unknown>[]
  datasetAnalyses: Record<string, Record<string, unknown>[]>
  attachments: (Record<string, unknown> & { dataBase64: string })[]
}

const input = JSON.parse(readFileSync(join(GOLDEN_DIR, 'input.json'), 'utf8')) as GoldenInput

// The project's inline organization resolves via the parent workspace (the project
// carries no org snapshot of its own — organization:null in the fixture).
const project = input.project
const byDashboardId = new Map(input.dashboards.map((g) => [g.dashboard.id as string, g]))
const tabsByDashboard = new Map(input.dashboards.map((g) => [g.dashboard.id as string, g.tabs]))
const widgetsByTab = new Map<string, Record<string, unknown>[]>()
for (const g of input.dashboards) {
  for (const w of g.widgets) {
    const list = widgetsByTab.get(w.tabId as string) ?? []
    list.push(w)
    widgetsByTab.set(w.tabId as string, list)
  }
}

const storage = {
  projects: { getById: async () => project },
  ideFiles: { getByProject: async () => input.ideFiles },
  pipelines: { getByProject: async () => input.pipelines },
  cohorts: { getByProject: async () => input.cohorts },
  connections: { getByProject: async () => input.connections },
  dashboards: { getByProject: async () => input.dashboards.map((g) => g.dashboard) },
  dashboardTabs: { getByDashboard: async (id: string) => tabsByDashboard.get(id) ?? [] },
  dashboardWidgets: { getByTab: async (tabId: string) => widgetsByTab.get(tabId) ?? [] },
  datasetFiles: { getByProject: async () => input.datasetFiles },
  datasetAnalyses: { getByDataset: async (id: string) => input.datasetAnalyses[id] ?? [] },
  // Server-mode data adapters: rows are paginated on demand (never a whole blob),
  // and no raw file is returned in the no-include-data golden variant.
  datasetData: { get: async () => undefined },
  datasetRawFiles: { get: async () => undefined },
  readmeAttachments: {
    getByOwner: async () =>
      input.attachments.map(({ dataBase64, ...rest }) => ({
        ...rest,
        data: Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0)),
      })),
  },
  workspaces: { getById: async () => input.workspace },
  organizations: { getById: async () => input.organization },
} as unknown as Storage

void byDashboardId

async function buildTree(): Promise<Map<string, Uint8Array>> {
  const built = await buildProjectZip('proj-uid-1', storage, {})
  if (!built) throw new Error('build returned null')
  const zip = await JSZip.loadAsync(await built.blob.arrayBuffer())
  const out = new Map<string, Uint8Array>()
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue
    out.set(f.name, await f.async('uint8array'))
  }
  return out
}

describe('project export — golden format contract', () => {
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
      expect(Buffer.from(got!).equals(golden), `content mismatch for ${path}`).toBe(true)
    }
  })
})

function listExpected(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listExpected(join(root, entry.name), rel))
    else out.push(rel)
  }
  return out
}
