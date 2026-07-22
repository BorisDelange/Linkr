/**
 * Golden format contract for the workspace export ZIP (git variant).
 *
 * Freezes the EXACT extracted-file tree that `buildWorkspaceZip` produces, so the
 * server-side Python builder (apps/api/app/services/workspace_export.py) can be held
 * to the same bytes (see docs/architecture.md, "Fullstack Storage & Compute"). We compare the
 * DECOMPRESSED per-file contents, not the raw .zip container — git versions the
 * extracted tree, and the container isn't byte-reproducible across JSZip and Python
 * zipfile.
 *
 * The fixture (`input.json`) uses the SAME shapes the frontend's Storage yields in
 * server mode (camelCase, API field order), so the TS builder here and the Python
 * builder's twin test (apps/api/tests/test_workspace_export.py) consume identical
 * input and must emit identical bytes. It exercises: a lightweight project, a
 * full-data project (nested tree), a git-linked project (pointer), a wiki page +
 * attachment, a database (credentials stripped, password never), a full mapping
 * project, and git-links.json.
 *
 * The built-in-plugin filter (buildWorkspaceZip skips workspace copies of app
 * built-ins via the registry) is deliberately NOT exercised here: the fixture's one
 * plugin is user-authored (not in the registry), so both builders export it and the
 * golden stays independent of the frontend registry. See the server report note.
 *
 * To regenerate the golden after an intentional format change, run BOTH:
 *   (ts)     GOLDEN_UPDATE=1 npx vitest run src/lib/workspace-export-golden.test.ts
 *   (python) GOLDEN_UPDATE=1 pytest tests/test_workspace_export.py
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildWorkspaceZip } from './entity-io'
import type { Storage } from '@/lib/storage'

// buildWorkspaceZip nests each full-data project by re-loading its sub-ZIP Blob
// (JSZip.loadAsync(sub.blob)). JSZip only reads a Blob through a FileReader, which
// the Node test environment lacks — so provide a minimal one backed by Node's
// Blob.arrayBuffer(). Browser/front-only runs use the real FileReader unchanged.
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | null = null
    onload: ((e: { target: NodeFileReader }) => void) | null = null
    onerror: ((e: { target: { error: unknown } }) => void) | null = null
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (buf) => {
          this.result = buf
          this.onload?.({ target: this })
        },
        (error) => this.onerror?.({ target: { error } }),
      )
    }
  }
  ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
}

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, '__fixtures__', 'export-golden', 'workspace')
const EXPECTED_DIR = join(GOLDEN_DIR, 'expected')
const UPDATE = process.env.GOLDEN_UPDATE === '1'

interface GoldenInput {
  workspace: Record<string, unknown>
  organization: Record<string, unknown>
  projects: Record<string, unknown>[]
  includeEntityData: Record<string, boolean>
  projectIdeFiles: Record<string, Record<string, unknown>[]>
  wikiPages: Record<string, unknown>[]
  wikiAttachments: (Record<string, unknown> & { dataBase64: string })[]
  dataSources: Record<string, unknown>[]
  mappingProjects: Record<string, unknown>[]
  sourceCsvBase64: string
  mappings: Record<string, unknown>[]
  ranges: Record<string, unknown>[]
  entries: Record<string, unknown>[]
  userPlugins: Record<string, unknown>[]
}

const input = JSON.parse(readFileSync(join(GOLDEN_DIR, 'input.json'), 'utf8')) as GoldenInput

const projectByUid = new Map(input.projects.map((p) => [p.uid as string, p]))
const bytesFromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// The mapping project's rawFileBuffer (the git variant writes source-concepts.csv
// verbatim from it) — JSON can't hold a Uint8Array, so reattach it here. Only for
// file-source projects that carry fileSourceData; a git-linked pointer has none.
const mappingProjects = input.mappingProjects.map((mp) =>
  mp.fileSourceData
    ? {
        ...mp,
        fileSourceData: {
          ...(mp.fileSourceData as Record<string, unknown>),
          rawFileBuffer: bytesFromB64(input.sourceCsvBase64),
        },
      }
    : mp,
)

const storage = {
  workspaces: { getById: async () => input.workspace },
  organizations: { getById: async () => input.organization },
  projects: {
    getAll: async () => input.projects,
    getById: async (uid: string) => projectByUid.get(uid),
  },
  // Full project sub-tree (buildProjectZip) reads these; only proj-full is bundled.
  ideFiles: { getByProject: async (uid: string) => input.projectIdeFiles[uid] ?? [] },
  pipelines: { getByProject: async () => [] },
  cohorts: { getByProject: async () => [] },
  connections: { getByProject: async () => [] },
  dashboards: { getByProject: async () => [] },
  dashboardTabs: { getByDashboard: async () => [] },
  dashboardWidgets: { getByTab: async () => [] },
  datasetFiles: { getByProject: async () => [] },
  datasetData: { get: async () => undefined },
  datasetRawFiles: { get: async () => undefined },
  datasetAnalyses: { getByDataset: async () => [] },
  readmeAttachments: { getByProject: async () => [] },
  wikiPages: { getByWorkspace: async () => input.wikiPages },
  wikiAttachments: {
    getByWorkspace: async () =>
      input.wikiAttachments.map(({ dataBase64, ...rest }) => ({
        ...rest,
        data: bytesFromB64(dataBase64),
      })),
  },
  schemaPresets: { getByWorkspace: async () => [] },
  dataSources: { getByWorkspace: async () => input.dataSources },
  sqlScriptCollections: { getByWorkspace: async () => [] },
  etlPipelines: { getByWorkspace: async () => [] },
  dqRuleSets: { getByWorkspace: async () => [] },
  dqCustomChecks: { getByRuleSet: async () => [] },
  mappingProjects: {
    getByWorkspace: async () => mappingProjects,
    getById: async (id: string) => mappingProjects.find((m) => m.id === id),
  },
  conceptMappings: { getByProject: async () => input.mappings },
  sourceConceptIdRanges: {
    getByWorkspace: async () => input.ranges,
    get: async (_ws: string, label: string) => input.ranges.find((r) => r.badgeLabel === label),
  },
  sourceConceptIdEntries: {
    getByWorkspaceAndBadge: async (_ws: string, label: string) =>
      input.entries.filter((e) => e.badgeLabel === label),
  },
  dataCatalogs: { getByWorkspace: async () => [] },
  serviceMappings: { getByWorkspace: async () => [] },
  userPlugins: { getByWorkspace: async () => input.userPlugins },
} as unknown as Storage

async function buildTree(): Promise<Map<string, Uint8Array>> {
  const built = await buildWorkspaceZip('ws1', storage, {
    includeEntityData: input.includeEntityData,
  })
  if (!built) throw new Error('build returned null')
  const zip = await JSZip.loadAsync(await built.blob.arrayBuffer())
  const out = new Map<string, Uint8Array>()
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue
    out.set(f.name, await f.async('uint8array'))
  }
  return out
}

describe('workspace export — golden format contract', () => {
  it('reproduces the frozen extracted-file tree byte for byte', async () => {
    const tree = await buildTree()

    if (UPDATE) {
      // Regenerate from scratch: drop the old tree first so a removed file doesn't
      // linger and fail the (post-write) path assertion below. Then re-emit.
      rmSync(EXPECTED_DIR, { recursive: true, force: true })
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
