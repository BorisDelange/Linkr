/**
 * Golden format contract for the mapping-project export ZIP (git variant).
 *
 * Freezes the EXACT extracted-file tree that `buildMappingProjectFolder` +
 * `buildProjectSourceConceptIds` produce, so a server-side Python builder can be
 * held to the same bytes (see docs/planning/server-export-plan.md §4bis). We
 * compare the DECOMPRESSED per-file contents, not the raw .zip container — git
 * versions the extracted tree, and the container isn't byte-reproducible across
 * JSZip and Python zipfile.
 *
 * To regenerate the golden after an intentional format change:
 *   GOLDEN_UPDATE=1 npx vitest run src/lib/concept-mapping/export-golden.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { buildMappingProjectZip } from './export'
import type { Storage } from '@/lib/storage'
import type { ConceptMapping, MappingProject, Organization, SourceConceptIdEntry, SourceConceptIdRange, Workspace } from '@/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_DIR = join(HERE, '__fixtures__', 'export-golden', 'mapping-project')
const EXPECTED_DIR = join(GOLDEN_DIR, 'expected')
const UPDATE = process.env.GOLDEN_UPDATE === '1'

// --- Frozen input -----------------------------------------------------------
// Deterministic: no timestamps/uuids reach the export path, so the same input
// always yields the same bytes. Values are chosen to exercise ordering (badges,
// many-to-many mappings, entries across vocabularies).

const CSV = 'terminology,concept_code,concept_name\nLOINC,20112-9,Tidal volume\nLOINC,"a,b",Comma name\n'

const project = {
  id: 'proj1',
  entityId: 'adult-icu',
  workspaceId: 'ws1',
  name: { en: 'Adult ICU', fr: 'Réanimation adulte' },
  description: { en: 'ICU mapping' },
  status: 'in_progress',
  sourceType: 'file',
  dataSourceId: 'ds-local-uuid',
  badges: [{ id: 'b1', label: { en: 'Rennes' }, color: 'blue' }],
  fileSourceData: {
    fileName: 'source-concepts.csv',
    columns: ['terminology', 'concept_code', 'concept_name'],
    columnMapping: { terminologyColumn: 'terminology', conceptCodeColumn: 'concept_code', conceptNameColumn: 'concept_name' },
    rawFileBuffer: new TextEncoder().encode(CSV),
    rows: [],
    totalRowCount: 2,
  },
} as unknown as MappingProject

function mapping(over: Partial<ConceptMapping>): ConceptMapping {
  return {
    id: 'm', projectId: 'proj1',
    sourceConceptId: 1, sourceConceptName: 'x', sourceVocabularyId: 'LOINC', sourceConceptCode: '20112-9',
    targetConceptId: 3000905, targetConceptName: 'Tidal volume', targetVocabularyId: 'LOINC', targetConceptCode: '20112-9',
    equivalence: 'skos:exactMatch', status: 'unchecked', mappedBy: 'Boris',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as ConceptMapping
}

const mappings: ConceptMapping[] = [
  mapping({ id: 'm2', sourceConceptCode: 'ZZ', sourceConceptName: 'last' }),
  mapping({ id: 'm1', sourceConceptCode: 'AA', sourceConceptName: 'first' }),
]

const ranges: SourceConceptIdRange[] = [
  { id: 'ws1__Rennes', workspaceId: 'ws1', badgeLabel: 'Rennes', rangeStart: 2000000001, rangeEnd: 2001000000, nextId: 2000000003, totalConcepts: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]
const entries: SourceConceptIdEntry[] = [
  { id: 'ws1__Rennes__LOINC__20112-9', workspaceId: 'ws1', badgeLabel: 'Rennes', vocabularyId: 'LOINC', conceptCode: '20112-9', sourceConceptId: 2000000001, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'ws1__Rennes__LOINC__a,b', workspaceId: 'ws1', badgeLabel: 'Rennes', vocabularyId: 'LOINC', conceptCode: 'a,b', sourceConceptId: 2000000002, createdAt: '2026-01-01T00:00:00Z' },
]

const workspace = { id: 'ws1', organizationId: 'org1' } as unknown as Workspace
const organization = {
  id: 'org1', name: { en: 'CHU Rennes' }, type: 'hospital',
  location: { en: 'Rennes' }, country: { en: 'France' }, website: 'https://chu-rennes.fr',
} as unknown as Organization

const storage = {
  conceptMappings: { getByProject: async () => mappings },
  mappingProjects: { getById: async () => project },
  workspaces: { getById: async () => workspace },
  organizations: { getById: async () => organization },
  sourceConceptIdRanges: { get: async (_ws: string, label: string) => ranges.find((r) => r.badgeLabel === label) },
  sourceConceptIdEntries: { getByWorkspaceAndBadge: async (_ws: string, label: string) => entries.filter((e) => e.badgeLabel === label) },
} as unknown as Storage

async function buildTree(): Promise<Map<string, string>> {
  // Exercise the full git variant (buildMappingProjectZip): folder content +
  // inline organization + .gitignore. No lfsOverrides → no .gitattributes. This
  // is the exact tree the server-side Python builder must reproduce.
  const built = await buildMappingProjectZip('proj1', storage)
  if (!built) throw new Error('build returned null')
  const zip = await JSZip.loadAsync(await built.blob.arrayBuffer())
  const out = new Map<string, string>()
  const files = Object.values(zip.files).filter((f) => !f.dir)
  for (const f of files) out.set(f.name, await f.async('string'))
  return out
}

describe('mapping-project export — golden format contract', () => {
  it('reproduces the frozen extracted-file tree byte for byte', async () => {
    const tree = await buildTree()

    if (UPDATE) {
      // Regenerate the golden; the assertions below then act as the check on the
      // committed fixture.
      for (const [path, content] of tree) {
        const dest = join(EXPECTED_DIR, path)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, content, 'utf8')
      }
    }

    // The set of paths must match exactly (no missing / extra file).
    const expectedPaths = listExpected(EXPECTED_DIR)
    expect([...tree.keys()].sort()).toEqual(expectedPaths.sort())

    // Each file's content must match the committed golden byte for byte.
    for (const path of expectedPaths) {
      const golden = readFileSync(join(EXPECTED_DIR, path), 'utf8')
      expect(tree.get(path), `content mismatch for ${path}`).toBe(golden)
    }
  })
})

/** Recursively list golden file paths relative to `root` (posix-style keys). */
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
