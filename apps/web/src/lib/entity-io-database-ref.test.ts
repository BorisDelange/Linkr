import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { applyClonedEntity, importProjectContent } from './entity-io'
import type { ParsedProjectZip } from './entity-io'
import type { Storage } from '@/lib/storage'

vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer: vi.fn() }))

// Node's JSZip cannot read a browser File (no FileReader), and applyClonedEntity
// builds one internally before handing it to parseProjectZip. Bridge it to an
// ArrayBuffer — the REAL parser still runs. Same shim as project-pull.test.ts.
vi.mock('jszip', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof JSZip }>()
  const Original = actual.default
  class Bridged extends Original {
    static async loadAsync(data: unknown, opts?: object) {
      const src = data instanceof Blob ? await data.arrayBuffer() : data
      return Original.loadAsync(src as never, opts as never)
    }
  }
  return { ...actual, default: Bridged }
})

// A patient board and a cohort each name the database they read. That id is this
// instance's local UUID, so the export strips it and carries `dataSourceRef`
// instead; the import resolves the pointer back to whatever local row matches.
// Get this wrong and an imported board silently reads another project's database.

const DATABASES = [
  { id: 'local-a', lineageId: 'lin-a', workspaceId: 'ws-1', name: { en: 'A' } },
  { id: 'local-b', lineageId: 'lin-b', workspaceId: 'ws-1', name: { en: 'B' } },
]

const emptyParsed = (over: Partial<ParsedProjectZip> = {}): ParsedProjectZip =>
  ({
    project: { uid: 'p1', name: { en: 'P' } },
    ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
    dashboards: [], dashboardTabs: [], dashboardWidgets: [],
    datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
    patientDashboards: [], patientDashboardTabs: [], patientDashboardWidgets: [],
    attachmentsMeta: [], attachmentBlobs: new Map(),
    ...over,
  }) as unknown as ParsedProjectZip

const makeStore = () => {
  const created: Record<string, Record<string, unknown>[]> = { cohorts: [], patientDashboards: [] }
  const store = new Proxy({}, {
    get: (_t, prop) => {
      const p = String(prop)
      if (p === 'dataSources') return { getAll: async () => DATABASES }
      if (created[p]) {
        return { create: async (row: Record<string, unknown>) => { created[p].push(row) } }
      }
      return new Proxy({}, { get: () => async () => {} })
    },
  }) as unknown as Storage
  return { store, created }
}

describe('importProjectContent — portable database pointer', () => {
  it('resolves a cohort’s dataSourceRef to the local database id', async () => {
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceRef: { lineageId: 'lin-b' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.cohorts[0]?.dataSourceId).toBe('local-b')
  })

  it('resolves a patient board’s dataSourceRef to the local database id', async () => {
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      patientDashboards: [{ id: 'b1', name: { en: 'B' }, dataSourceRef: { lineageId: 'lin-a' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.patientDashboards[0]?.dataSourceId).toBe('local-a')
  })

  it('leaves the database unset when the pointer matches nothing', async () => {
    // Imported into an instance that does not have that database. Leaving the id
    // unset lets the lazy fallback pick a usable one, rather than pointing the
    // board at an id no row has.
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceRef: { lineageId: 'lin-unknown' } }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store, { workspaceId: 'ws-1' })

    expect(created.cohorts[0]?.dataSourceId).toBeUndefined()
  })

  it('never carries a foreign dataSourceId through when no workspace is known', async () => {
    // Without a workspace the pointer cannot be resolved; the exporting instance's
    // raw id must not survive, or it would address an unrelated local row.
    const { store, created } = makeStore()
    const parsed = emptyParsed({
      cohorts: [{ id: 'c1', name: 'C', dataSourceId: 'foreign-uuid' }],
    } as unknown as Partial<ParsedProjectZip>)

    await importProjectContent(parsed, 'p1', store)

    expect(created.cohorts[0]?.dataSourceId).toBeUndefined()
  })
})

// A git-linked project is imported from the workspace as a bare POINTER (uid,
// name, gitRemoteConfig) — `linkedDataSourceRefs` lives only in the project's own
// repo. So the workspace import's re-link step sees no refs and cannot restore
// the links; this clone is the only place they can be resolved. Miss it and
// `linkedDataSourceIds` stays empty, which `resolveProjectSource` filters on —
// leaving every warehouse screen (Concepts, Patient data, Cohorts) with no
// database at all, and no fallback able to pick one.
describe('applyClonedEntity(project) — restoring the database links', () => {
  const clonedProjectZip = (project: Record<string, unknown>) => {
    const zip = new JSZip()
    zip.file('project.json', JSON.stringify(project))
    return zip
  }

  /** Captures projects.update; dataSources.getAll answers with DATABASES. */
  const makeProjectStore = () => {
    const updates: Record<string, unknown>[] = []
    const store = new Proxy({}, {
      get: (_t, prop) => {
        const p = String(prop)
        if (p === 'dataSources') return { getAll: async () => DATABASES }
        if (p === 'projects') {
          return {
            update: async (_id: string, changes: Record<string, unknown>) => { updates.push(changes) },
            getById: async () => undefined,
          }
        }
        return new Proxy({}, { get: () => async () => [] })
      },
    }) as unknown as Storage
    return { store, updates }
  }

  it('resolves the repo’s linkedDataSourceRefs into local ids', async () => {
    const { store, updates } = makeProjectStore()
    const zip = clonedProjectZip({
      uid: 'remote-uid',
      name: { en: 'P' },
      linkedDataSourceRefs: [{ lineageId: 'lin-b' }, { lineageId: 'lin-a' }],
    })

    expect(await applyClonedEntity(zip, 'project', 'p1', store, 'ws-1')).toBe(true)
    expect(updates[0]?.linkedDataSourceIds).toEqual(['local-b', 'local-a'])
  })

  it('keeps the refs’ order and drops the ones this instance does not hold', async () => {
    const { store, updates } = makeProjectStore()
    const zip = clonedProjectZip({
      uid: 'remote-uid',
      name: { en: 'P' },
      linkedDataSourceRefs: [{ lineageId: 'lin-a' }, { lineageId: 'lin-missing' }],
    })

    expect(await applyClonedEntity(zip, 'project', 'p1', store, 'ws-1')).toBe(true)
    expect(updates[0]?.linkedDataSourceIds).toEqual(['local-a'])
  })

  it('writes back the pointers it resolved, not the repo’s own list', async () => {
    // A published entity.json had accumulated the same pointer three times. Each
    // import resolved all three to one database and wrote the manifest's list
    // straight back, so the repeats survived every round trip and the project
    // stored more databases than its Databases page ever showed.
    const { store, updates } = makeProjectStore()
    const zip = clonedProjectZip({
      uid: 'remote-uid',
      name: { en: 'P' },
      linkedDataSourceRefs: [
        { lineageId: 'lin-a' },
        { lineageId: 'lin-b' },
        { lineageId: 'lin-a' },
        { lineageId: 'lin-missing' },
        { lineageId: 'lin-a' },
      ],
    })

    expect(await applyClonedEntity(zip, 'project', 'p1', store, 'ws-1')).toBe(true)
    expect(updates[0]?.linkedDataSourceIds).toEqual(['local-a', 'local-b'])
    expect(updates[0]?.linkedDataSourceRefs).toEqual([
      { lineageId: 'lin-a' },
      { lineageId: 'lin-b' },
    ])
  })

  it('leaves the stored links alone when NO ref resolves', async () => {
    // Same rule as resolveEntityLinks: a repo cloned where none of the referenced
    // databases exist must not blank a link the local row already holds.
    const { store, updates } = makeProjectStore()
    const zip = clonedProjectZip({
      uid: 'remote-uid',
      name: { en: 'P' },
      linkedDataSourceRefs: [{ lineageId: 'lin-missing' }],
    })

    expect(await applyClonedEntity(zip, 'project', 'p1', store, 'ws-1')).toBe(true)
    expect(updates[0]).not.toHaveProperty('linkedDataSourceIds')
  })

  it('never writes a foreign linkedDataSourceIds through', async () => {
    // The export strips it as an instance field, but a hand-edited repo could
    // carry one: those ids address rows in the EXPORTING instance, not this one.
    const { store, updates } = makeProjectStore()
    const zip = clonedProjectZip({
      uid: 'remote-uid',
      name: { en: 'P' },
      linkedDataSourceIds: ['foreign-1', 'foreign-2'],
    })

    expect(await applyClonedEntity(zip, 'project', 'p1', store, 'ws-1')).toBe(true)
    expect(updates[0]).not.toHaveProperty('linkedDataSourceIds')
  })
})
