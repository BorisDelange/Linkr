import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import { deterministicId } from '@/lib/deterministic-id'
import type { Storage } from '@/lib/storage'
import type { ParsedProjectZip } from '@/lib/entity-io'

const gitMocks = vi.hoisted(() => ({
  gitCloneToZip: vi.fn(),
  gitSetSyncState: vi.fn(async () => {}),
}))
vi.mock('@/lib/api/git', () => gitMocks)
vi.mock('@/lib/git-clone', () => ({ cleanGitUrl: (u: string) => u }))
vi.mock('@/lib/api-client', () => ({ isServerMode: () => false }))
vi.mock('@/lib/api/datasets', () => ({ importDatasetOnServer: vi.fn() }))

const storageHolder = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('@/lib/storage', () => ({ getStorage: () => storageHolder.current }))

// Node's JSZip cannot read a browser File (no FileReader), so bridge the File the
// pull hands to parseProjectZip into an ArrayBuffer — the REAL parser still runs.
vi.mock('@/lib/entity-io', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/entity-io')>()
  return {
    ...mod,
    parseProjectZip: async (file: File) =>
      mod.parseProjectZip((await file.arrayBuffer()) as unknown as File),
  }
})

import {
  prepareProjectPull,
  applyProjectPull,
  isCompleteProjectPull,
  type ProjectPullSelection,
  type PreparedProjectPull,
} from './project-pull'

type Rec = { id: string } & Record<string, unknown>

const P = 'proj-1'
const did = (id: string) => deterministicId(P, id)

/**
 * In-memory Storage stub mirroring the IDB adapter's write semantics — that
 * fidelity IS the regression guard: dashboards/tabs/widgets/cohorts/pipelines/
 * datasetFiles/datasetAnalyses create via `db.add` (a duplicate key REJECTS,
 * like the ConstraintError that left datasets half-deleted), while ideFiles
 * create and datasetData/datasetRawFiles save via `db.put` (silent upsert).
 */
function makeStore() {
  const ops: string[] = []
  const t = {
    projects: new Map<string, Rec>(),
    dashboards: new Map<string, Rec>(),
    dashboardTabs: new Map<string, Rec>(),
    dashboardWidgets: new Map<string, Rec>(),
    cohorts: new Map<string, Rec>(),
    pipelines: new Map<string, Rec>(),
    ideFiles: new Map<string, Rec>(),
    datasetFiles: new Map<string, Rec>(),
    datasetAnalyses: new Map<string, Rec>(),
    datasetData: new Map<string, Record<string, unknown>>(),
    datasetRawFiles: new Map<string, Record<string, unknown>>(),
  }

  const byProject = (map: Map<string, Rec>) => async (uid: string) =>
    [...map.values()].filter((r) => r.projectUid === uid)
  const addOnly = (name: string, map: Map<string, Rec>) => async (rec: Rec) => {
    ops.push(`${name}.create:${rec.id}`)
    if (map.has(rec.id)) throw new Error(`ConstraintError: duplicate key ${name}/${rec.id}`)
    map.set(rec.id, rec)
  }
  const del = (name: string, map: Map<string, Rec>) => async (id: string) => {
    ops.push(`${name}.delete:${id}`)
    map.delete(id)
  }

  const storage = {
    projects: {
      getById: async (uid: string) => t.projects.get(uid),
      update: async (uid: string, changes: Record<string, unknown>) => {
        ops.push(`projects.update:${uid}`)
        t.projects.set(uid, { ...(t.projects.get(uid) as Rec), ...changes })
      },
    },
    dashboards: {
      getByProject: byProject(t.dashboards),
      create: addOnly('dashboards', t.dashboards),
      delete: del('dashboards', t.dashboards),
    },
    dashboardTabs: {
      getByDashboard: async (dashId: string) =>
        [...t.dashboardTabs.values()].filter((r) => r.dashboardId === dashId),
      deleteByDashboard: async (dashId: string) => {
        ops.push(`dashboardTabs.deleteByDashboard:${dashId}`)
        for (const [id, r] of t.dashboardTabs) if (r.dashboardId === dashId) t.dashboardTabs.delete(id)
      },
      create: addOnly('dashboardTabs', t.dashboardTabs),
    },
    dashboardWidgets: {
      deleteByTab: async (tabId: string) => {
        ops.push(`dashboardWidgets.deleteByTab:${tabId}`)
        for (const [id, r] of t.dashboardWidgets) if (r.tabId === tabId) t.dashboardWidgets.delete(id)
      },
      create: addOnly('dashboardWidgets', t.dashboardWidgets),
    },
    cohorts: {
      getByProject: byProject(t.cohorts),
      create: addOnly('cohorts', t.cohorts),
      delete: del('cohorts', t.cohorts),
    },
    pipelines: {
      getByProject: byProject(t.pipelines),
      create: addOnly('pipelines', t.pipelines),
      delete: del('pipelines', t.pipelines),
    },
    ideFiles: {
      getByProject: byProject(t.ideFiles),
      create: async (rec: Rec) => {
        ops.push(`ideFiles.create:${rec.id}`)
        t.ideFiles.set(rec.id, rec)
      },
      delete: del('ideFiles', t.ideFiles),
    },
    datasetFiles: {
      getByProject: byProject(t.datasetFiles),
      create: addOnly('datasetFiles', t.datasetFiles),
      delete: del('datasetFiles', t.datasetFiles),
    },
    datasetAnalyses: {
      create: addOnly('datasetAnalyses', t.datasetAnalyses),
      deleteByDataset: async (dsId: string) => {
        ops.push(`datasetAnalyses.deleteByDataset:${dsId}`)
        for (const [id, r] of t.datasetAnalyses) if (r.datasetFileId === dsId) t.datasetAnalyses.delete(id)
      },
    },
    datasetData: {
      save: async (rec: { datasetFileId: string }) => {
        ops.push(`datasetData.save:${rec.datasetFileId}`)
        t.datasetData.set(rec.datasetFileId, rec)
      },
      delete: async (id: string) => {
        ops.push(`datasetData.delete:${id}`)
        t.datasetData.delete(id)
      },
    },
    datasetRawFiles: {
      save: async (rec: { datasetFileId: string }) => {
        ops.push(`datasetRawFiles.save:${rec.datasetFileId}`)
        t.datasetRawFiles.set(rec.datasetFileId, rec)
      },
      delete: async (id: string) => {
        ops.push(`datasetRawFiles.delete:${id}`)
        t.datasetRawFiles.delete(id)
      },
    },
    connections: { create: async () => {} },
    readmeAttachments: { create: async () => {} },
  } as unknown as Storage

  return { storage, ops, t }
}

const emptyParsed = (over: Partial<ParsedProjectZip> = {}): ParsedProjectZip => ({
  project: { uid: 'remote-uid', name: { en: 'Remote' } } as unknown as ParsedProjectZip['project'],
  ideFiles: [], pipelines: [], cohorts: [], connections: [], conceptLists: [],
  dashboards: [], dashboardTabs: [], dashboardWidgets: [],
  datasetFiles: [], datasetAnalyses: [], datasetData: [], datasetRawFiles: [],
  attachmentsMeta: [], attachmentBlobs: new Map(), ...over,
})

const preparedWith = (
  parsed: ParsedProjectZip,
  clonedOid: string | null = 'oid-123',
): PreparedProjectPull => ({
  parsed,
  plan: { dashboards: [], scripts: [], cohorts: [], datasets: [], pipeline: [], readmeChanged: false },
  clonedOid,
  branch: 'main',
})

const sel = (over: Partial<ProjectPullSelection> = {}): ProjectPullSelection => ({
  dashboards: new Set(), scripts: new Set(), cohorts: new Set(),
  datasets: new Set(), pipeline: new Set(), readme: false, ...over,
})

const mustIndexOf = (ops: string[], op: string): number => {
  const i = ops.indexOf(op)
  expect(i, `expected op "${op}" in [${ops.join(', ')}]`).toBeGreaterThanOrEqual(0)
  return i
}

beforeEach(() => {
  gitMocks.gitCloneToZip.mockReset()
  gitMocks.gitSetSyncState.mockReset()
  gitMocks.gitSetSyncState.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// prepareProjectPull — clone → parse → per-group new-vs-existing plan
// ---------------------------------------------------------------------------

async function stubClone(build: (zip: JSZip) => void, oid: string | null = 'oid-123') {
  const zip = new JSZip()
  zip.file('project.json', JSON.stringify({ uid: 'remote-uid', name: { en: 'Remote' } }))
  build(zip)
  const buf = await zip.generateAsync({ type: 'arraybuffer' })
  gitMocks.gitCloneToZip.mockResolvedValue({ blob: new Blob([buf]), oid })
}

const seedLinkedProject = (t: ReturnType<typeof makeStore>['t']) => {
  t.projects.set(P, { id: P, uid: P, gitRemoteConfig: { url: 'https://git.host/x.git', branch: 'main' } })
}

describe('prepareProjectPull — natural-key matching', () => {
  it('rejects when the project has no git remote', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    t.projects.set(P, { id: P, uid: P })
    await expect(prepareProjectPull(P, 'main')).rejects.toThrow('not linked to a git remote')
    expect(gitMocks.gitCloneToZip).not.toHaveBeenCalled()
  })

  it('marks remote entities existing (overwrite) vs new (add), per group', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    seedLinkedProject(t)
    // Locals: dashboard name differs only by CASE (slug key must still match),
    // cohort matches, no pipeline, script at the same tree path, no dataset.
    t.dashboards.set('local-d', { id: 'local-d', projectUid: P, name: { en: 'ANALYTICS' } })
    t.cohorts.set('local-c', { id: 'local-c', projectUid: P, name: 'sepsis' })
    t.ideFiles.set('lf', { id: 'lf', projectUid: P, name: 'utils', type: 'folder', parentId: null })
    t.ideFiles.set('ls', { id: 'ls', projectUid: P, name: 'analysis.py', type: 'file', parentId: 'lf' })

    await stubClone((zip) => {
      zip.file('dashboards/analytics.json', JSON.stringify({
        dashboard: { id: 'dash-1', name: { en: 'Analytics' } }, tabs: [], widgets: [],
      }))
      zip.file('dashboards/new-board.json', JSON.stringify({
        dashboard: { id: 'dash-2', name: { en: 'New Board' } }, tabs: [], widgets: [],
      }))
      zip.file('cohorts/sepsis.json', JSON.stringify({ id: 'c-1', name: 'Sepsis' }))
      zip.file('pipeline/pipeline.json', JSON.stringify([{ id: 'pl-1', name: { en: 'Main Pipeline' } }]))
      zip.file('scripts/_tree.json', JSON.stringify([
        { path: 'utils', type: 'folder' },
        { path: 'utils/analysis.py', type: 'file' },
        { path: 'new.py', type: 'file' },
      ]))
      zip.file('scripts/utils/analysis.py', 'print(1)')
      zip.file('scripts/new.py', 'print(2)')
      zip.file('datasets/_tree.json', JSON.stringify([
        { id: 'ds-1', name: 'data.csv', type: 'file', parentId: null },
      ]))
    })

    const prepared = await prepareProjectPull(P, 'main')

    const byKey = (items: { key: string; exists: boolean; label: string }[]) =>
      new Map(items.map((i) => [i.key, i]))
    const dash = byKey(prepared.plan.dashboards)
    expect(dash.get('analytics')).toMatchObject({ exists: true, label: 'Analytics' })
    expect(dash.get('new-board')).toMatchObject({ exists: false })
    expect(byKey(prepared.plan.cohorts).get('sepsis')).toMatchObject({ exists: true, label: 'Sepsis' })
    expect(byKey(prepared.plan.pipeline).get('main-pipeline')).toMatchObject({ exists: false })
    expect(byKey(prepared.plan.scripts).get('utils/analysis.py')).toMatchObject({ exists: true })
    expect(byKey(prepared.plan.scripts).get('new.py')).toMatchObject({ exists: false })
    expect(byKey(prepared.plan.datasets).get('data.csv')).toMatchObject({ exists: false })
    expect(prepared.clonedOid).toBe('oid-123')
    expect(prepared.branch).toBe('main')
  })

  it('two remote dashboards with the same name collapse onto the same key (current behavior)', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    seedLinkedProject(t)
    await stubClone((zip) => {
      zip.file('dashboards/dup-1.json', JSON.stringify({
        dashboard: { id: 'dash-a', name: { en: 'Dup' } }, tabs: [], widgets: [],
      }))
      zip.file('dashboards/dup-2.json', JSON.stringify({
        dashboard: { id: 'dash-b', name: { en: 'Dup' } }, tabs: [], widgets: [],
      }))
    })
    const prepared = await prepareProjectPull(P, 'main')
    // Selection is keyed by the slug, so homonyms are indistinguishable: picking
    // "dup" pulls both. The plan faithfully exposes the duplicate keys.
    expect(prepared.plan.dashboards.map((d) => d.key)).toEqual(['dup', 'dup'])
  })

  it('an unnamed dashboard falls back to its id as the natural key', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    seedLinkedProject(t)
    await stubClone((zip) => {
      zip.file('dashboards/unnamed.json', JSON.stringify({
        dashboard: { id: 'dash-9', name: {} }, tabs: [], widgets: [],
      }))
    })
    const prepared = await prepareProjectPull(P, 'main')
    expect(prepared.plan.dashboards).toEqual([{ key: 'dash-9', label: 'dash-9', exists: false }])
  })

  it('readmeChanged reflects a README difference (false when both sides are empty)', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    seedLinkedProject(t)
    await stubClone(() => {})
    expect((await prepareProjectPull(P, 'main')).plan.readmeChanged).toBe(false)

    await stubClone((zip) => zip.file('README.md', '# hello'))
    expect((await prepareProjectPull(P, 'main')).plan.readmeChanged).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyProjectPull — delete-then-import overlay
// ---------------------------------------------------------------------------

describe('applyProjectPull — dashboard overwrite', () => {
  it('deletes widgets → tabs → dashboard before re-import, and keeps unselected local dashboards', async () => {
    const { storage, ops, t } = makeStore()
    storageHolder.current = storage
    // Local "Analytics" sits at the SAME deterministic id the import will derive —
    // without the delete-first the add-only create rejects, so this test proves
    // the overwrite path end to end.
    t.dashboards.set(did('dash-1'), { id: did('dash-1'), projectUid: P, name: { en: 'Analytics' }, description: { en: 'v1' } })
    t.dashboardTabs.set('tab-local', { id: 'tab-local', dashboardId: did('dash-1') })
    t.dashboardWidgets.set('w-local', { id: 'w-local', tabId: 'tab-local' })
    t.dashboards.set('other-d', { id: 'other-d', projectUid: P, name: { en: 'Other' } })
    t.dashboardTabs.set('tab-other', { id: 'tab-other', dashboardId: 'other-d' })

    const parsed = emptyParsed({
      dashboards: [{ id: 'dash-1', name: { en: 'Analytics' }, description: { en: 'v2' } } as unknown as ParsedProjectZip['dashboards'][number]],
      dashboardTabs: [{ id: 'tab-1', dashboardId: 'dash-1', name: { en: 'Main' } } as unknown as ParsedProjectZip['dashboardTabs'][number]],
      dashboardWidgets: [{ id: 'w-1', tabId: 'tab-1' } as unknown as ParsedProjectZip['dashboardWidgets'][number]],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ dashboards: new Set(['analytics']) }))

    const iWidgets = mustIndexOf(ops, 'dashboardWidgets.deleteByTab:tab-local')
    const iTabs = mustIndexOf(ops, `dashboardTabs.deleteByDashboard:${did('dash-1')}`)
    const iDash = mustIndexOf(ops, `dashboards.delete:${did('dash-1')}`)
    const iCreate = mustIndexOf(ops, `dashboards.create:${did('dash-1')}`)
    expect(iWidgets).toBeLessThan(iTabs)
    expect(iTabs).toBeLessThan(iDash)
    expect(iDash).toBeLessThan(iCreate)

    expect(t.dashboards.get(did('dash-1'))?.description).toEqual({ en: 'v2' })
    expect(t.dashboardTabs.get(did('tab-1'))).toMatchObject({ dashboardId: did('dash-1') })
    expect(t.dashboardWidgets.get(did('w-1'))).toMatchObject({ tabId: did('tab-1') })
    expect(t.dashboardTabs.has('tab-local')).toBe(false)
    expect(t.dashboardWidgets.has('w-local')).toBe(false)
    // Additive overlay: the unselected local dashboard and its tab are untouched.
    expect(t.dashboards.get('other-d')?.name).toEqual({ en: 'Other' })
    expect(t.dashboardTabs.has('tab-other')).toBe(true)

    // reviewedOnly=false: a complete pull advances the CONTENT anchor, not just
    // the review cursor.
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledExactlyOnceWith('projects', P, 'main', 'oid-123', false)
  })

  it('key-based export: tabs and widgets ride with their dashboard via the key prefix', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    // Current git exports strip dashboard/tab/widget ids and carry content keys.
    const parsed = emptyParsed({
      dashboards: [{ name: { en: 'Analytics' } } as unknown as ParsedProjectZip['dashboards'][number]],
      dashboardTabs: [{ key: 'analytics/main', name: { en: 'Main' } } as unknown as ParsedProjectZip['dashboardTabs'][number]],
      dashboardWidgets: [{ key: 'analytics/main#w0', tabKey: 'analytics/main' } as unknown as ParsedProjectZip['dashboardWidgets'][number]],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ dashboards: new Set(['analytics']) }))

    expect(t.dashboards.get(did('analytics'))).toMatchObject({ projectUid: P })
    expect(t.dashboardTabs.get(did('analytics/main'))).toMatchObject({ dashboardId: did('analytics') })
    expect(t.dashboardWidgets.get(did('analytics/main#w0'))).toMatchObject({ tabId: did('analytics/main') })
  })
})

describe('applyProjectPull — additive overlay', () => {
  it('adds remote-only entities, keeps local-only ones, leaves unselected groups untouched', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    t.cohorts.set('keep-c', { id: 'keep-c', projectUid: P, name: 'Local Only' })
    t.pipelines.set('keep-p', { id: 'keep-p', projectUid: P, name: { en: 'ETL' } })

    const parsed = emptyParsed({
      cohorts: [{ id: 'c-1', name: 'Sepsis' } as unknown as ParsedProjectZip['cohorts'][number]],
      // Same natural key as the local pipeline, but the pipeline group is NOT
      // selected — it must survive untouched (no delete, no import).
      pipelines: [{ id: 'pl-1', name: { en: 'ETL' } } as unknown as ParsedProjectZip['pipelines'][number]],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ cohorts: new Set(['sepsis']) }))

    expect(t.cohorts.get('keep-c')?.name).toBe('Local Only')
    expect(t.cohorts.get(did('c-1'))).toMatchObject({ name: 'Sepsis', projectUid: P })
    expect(t.cohorts.size).toBe(2)
    expect([...t.pipelines.keys()]).toEqual(['keep-p'])
  })

  it('narrows the import to the selected datasets only (data/analyses ride with their file)', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    const mk = (id: string, name: string) =>
      ({ id, name, type: 'file', parentId: null } as unknown as ParsedProjectZip['datasetFiles'][number])
    const parsed = emptyParsed({
      datasetFiles: [mk('ds-a', 'a.csv'), mk('ds-b', 'b.csv')],
      datasetAnalyses: [
        { id: 'an-a', datasetFileId: 'ds-a', config: {} } as unknown as ParsedProjectZip['datasetAnalyses'][number],
        { id: 'an-b', datasetFileId: 'ds-b', config: {} } as unknown as ParsedProjectZip['datasetAnalyses'][number],
      ],
      datasetData: [
        { datasetFileId: 'ds-a', rows: [{ x: 1 }] },
        { datasetFileId: 'ds-b', rows: [{ x: 2 }] },
      ],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ datasets: new Set(['a.csv']) }))

    expect([...t.datasetFiles.keys()]).toEqual([did('ds-a')])
    expect([...t.datasetAnalyses.keys()]).toEqual([did('an-a')])
    expect([...t.datasetData.keys()]).toEqual([did('ds-a')])
  })
})

describe('applyProjectPull — dataset overwrite (the half-deleted-dataset regression)', () => {
  it('deletes analyses AND data AND raw file AND the dataset file before re-import', async () => {
    const { storage, ops, t } = makeStore()
    storageHolder.current = storage
    // Everything seeded at the deterministic ids the re-import derives: skipping
    // ANY of the four deletes makes an add-only create reject (the past data-loss
    // bug: analyses not deleted → ConstraintError → half-deleted dataset).
    t.datasetFiles.set(did('ds-1'), { id: did('ds-1'), projectUid: P, name: 'data.csv', type: 'file', parentId: null })
    t.datasetAnalyses.set(did('an-1'), { id: did('an-1'), datasetFileId: did('ds-1'), config: { col: 'old' } })
    t.datasetData.set(did('ds-1'), { datasetFileId: did('ds-1'), rows: [{ a: 1 }] })
    t.datasetRawFiles.set(did('ds-1'), { datasetFileId: did('ds-1'), fileName: 'old.csv' })

    const parsed = emptyParsed({
      datasetFiles: [{ id: 'ds-1', name: 'data.csv', type: 'file', parentId: null } as unknown as ParsedProjectZip['datasetFiles'][number]],
      datasetAnalyses: [{ id: 'an-1', datasetFileId: 'ds-1', config: { col: 'new' } } as unknown as ParsedProjectZip['datasetAnalyses'][number]],
      datasetData: [{ datasetFileId: 'ds-1', rows: [{ a: 2 }] }],
      datasetRawFiles: [{ datasetFileId: 'ds-1', blob: new Blob(['a\n2']), fileName: 'data.csv' }],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ datasets: new Set(['data.csv']) }))

    const iCreate = mustIndexOf(ops, `datasetFiles.create:${did('ds-1')}`)
    for (const op of [
      `datasetAnalyses.deleteByDataset:${did('ds-1')}`,
      `datasetData.delete:${did('ds-1')}`,
      `datasetRawFiles.delete:${did('ds-1')}`,
      `datasetFiles.delete:${did('ds-1')}`,
    ]) {
      expect(mustIndexOf(ops, op)).toBeLessThan(iCreate)
    }

    expect(t.datasetFiles.size).toBe(1)
    expect(t.datasetAnalyses.get(did('an-1'))?.config).toEqual({ col: 'new' })
    expect(t.datasetAnalyses.size).toBe(1)
    expect(t.datasetData.get(did('ds-1'))).toMatchObject({ rows: [{ a: 2 }] })
    expect(t.datasetRawFiles.get(did('ds-1'))).toMatchObject({ fileName: 'data.csv' })
  })

  it('overwrites a script by path, keeping local-only scripts and the shared folder', async () => {
    const { storage, ops, t } = makeStore()
    storageHolder.current = storage
    // IDE ids derive from (projectUid, tree path) — see entity-tree.ts.
    t.ideFiles.set(did('utils'), { id: did('utils'), projectUid: P, name: 'utils', type: 'folder', parentId: null })
    t.ideFiles.set(did('utils/analysis.py'), { id: did('utils/analysis.py'), projectUid: P, name: 'analysis.py', type: 'file', parentId: did('utils'), content: 'old' })
    t.ideFiles.set('local-only', { id: 'local-only', projectUid: P, name: 'notes.md', type: 'file', parentId: null })

    const parsed = emptyParsed({
      ideFiles: [
        { path: 'utils', type: 'folder' } as unknown as ParsedProjectZip['ideFiles'][number],
        { path: 'utils/analysis.py', type: 'file', content: 'new' } as unknown as ParsedProjectZip['ideFiles'][number],
      ],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ scripts: new Set(['utils/analysis.py']) }))

    // Only the FILE is deleted; the folder is upserted in place (IDB put), so the
    // tree keeps a single utils/ folder and the file lands with the new content.
    expect(ops).toContain(`ideFiles.delete:${did('utils/analysis.py')}`)
    expect(ops).not.toContain(`ideFiles.delete:${did('utils')}`)
    expect(t.ideFiles.get(did('utils/analysis.py'))).toMatchObject({ content: 'new', parentId: did('utils') })
    expect(t.ideFiles.get('local-only')).toBeDefined()
    expect(t.ideFiles.size).toBe(3)
  })
})

describe('applyProjectPull — readme block', () => {
  it('updates readme/todos/notes when picked, without touching any entity group', async () => {
    const { storage, ops, t } = makeStore()
    storageHolder.current = storage
    t.projects.set(P, { id: P, uid: P, readme: { en: 'old' } })
    const parsed = emptyParsed({
      project: {
        uid: 'remote-uid', name: { en: 'Remote' },
        readme: { en: '# New' }, todos: [{ id: 't1', text: 'do', done: false }], notes: { en: 'n' },
      } as unknown as ParsedProjectZip['project'],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ readme: true }))

    expect(t.projects.get(P)).toMatchObject({ readme: { en: '# New' }, notes: { en: 'n' } })
    expect(ops).toEqual([`projects.update:${P}`])
  })
})

describe('applyProjectPull — failure paths (what is guaranteed today)', () => {
  it('a locally renamed entity colliding on its deterministic id makes the pull REJECT — never a silent drop', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    // Same origin entity (same deterministic id) renamed locally: the natural keys
    // no longer match, so it is NOT deleted as an overwrite, and the insert-only
    // re-import hits the duplicate key. Guaranteed today: the error propagates and
    // the sync anchor is NOT advanced.
    t.cohorts.set(did('c-1'), { id: did('c-1'), projectUid: P, name: 'Renamed' })
    const parsed = emptyParsed({
      cohorts: [{ id: 'c-1', name: 'Sepsis' } as unknown as ParsedProjectZip['cohorts'][number]],
    })

    await expect(
      applyProjectPull(P, preparedWith(parsed), sel({ cohorts: new Set(['sepsis']) })),
    ).rejects.toThrow(/ConstraintError/)

    expect(t.cohorts.get(did('c-1'))?.name).toBe('Renamed')
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  it('a failing datasetAnalyses.deleteByDataset is swallowed and the pull completes', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    t.datasetFiles.set(did('ds-1'), { id: did('ds-1'), projectUid: P, name: 'data.csv', type: 'file', parentId: null })
    ;(storage.datasetAnalyses as { deleteByDataset: unknown }).deleteByDataset =
      async () => { throw new Error('backend down') }

    const parsed = emptyParsed({
      datasetFiles: [{ id: 'ds-1', name: 'data.csv', type: 'file', parentId: null } as unknown as ParsedProjectZip['datasetFiles'][number]],
      datasetAnalyses: [{ id: 'an-1', datasetFileId: 'ds-1', config: {} } as unknown as ParsedProjectZip['datasetAnalyses'][number]],
    })
    await applyProjectPull(P, preparedWith(parsed), sel({ datasets: new Set(['data.csv']) }))

    expect(t.datasetFiles.get(did('ds-1'))).toBeDefined()
    expect(t.datasetAnalyses.get(did('an-1'))).toBeDefined()
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledOnce()
  })

  it('a failing gitSetSyncState surfaces; no anchor call at all when clonedOid is null', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    gitMocks.gitSetSyncState.mockRejectedValue(new Error('offline'))
    const parsed = emptyParsed({
      cohorts: [{ id: 'c-1', name: 'Sepsis' } as unknown as ParsedProjectZip['cohorts'][number]],
    })
    // The content lands, but the cursor write fails — which must NOT read as a
    // successful pull: the caller would clear its draft and rebuild every later
    // plan against a base the server never recorded.
    await expect(
      applyProjectPull(P, preparedWith(parsed), sel({ cohorts: new Set(['sepsis']) })),
    ).rejects.toThrow('offline')
    expect(t.cohorts.get(did('c-1'))).toBeDefined()

    gitMocks.gitSetSyncState.mockClear()
    await applyProjectPull(P, preparedWith(emptyParsed(), null), sel({ readme: false }))
    expect(gitMocks.gitSetSyncState).not.toHaveBeenCalled()
  })

  it('keep-local writes nothing but anchors, so the behind banner clears', async () => {
    const { storage, t } = makeStore()
    storageHolder.current = storage
    const parsed = emptyParsed({
      cohorts: [{ id: 'c-1', name: 'Sepsis' } as unknown as ParsedProjectZip['cohorts'][number]],
    })
    // A plan with something on offer — the user is declining it, not pulling an
    // already-empty plan.
    const prepared = {
      ...preparedWith(parsed),
      plan: {
        dashboards: [], scripts: [], datasets: [], pipeline: [],
        cohorts: [{ key: 'sepsis', label: 'Sepsis', exists: false }],
        readmeChanged: false,
      },
    } as PreparedProjectPull

    await applyProjectPull(P, prepared, sel({ keepLocal: true }))

    expect(t.cohorts.get(did('c-1'))).toBeUndefined()
    // The REVIEW cursor only (reviewedOnly = true). Declining means we hold none
    // of this commit's content, so moving `syncedOid` — the 3-way merge base —
    // would make every later pull treat the declined cohort as already absorbed
    // and never offer it again. Asserting only "was called" is what let that
    // through: the bug was in the fifth argument, not in whether it fired.
    expect(gitMocks.gitSetSyncState).toHaveBeenCalledExactlyOnceWith(
      'projects', P, 'main', 'oid-123', true,
    )
  })
})

describe('isCompleteProjectPull', () => {
  const plan = (over: Partial<Record<string, unknown>> = {}) => ({
    dashboards: [{ key: 'd1', label: 'd1', exists: false }],
    scripts: [{ key: 's1', label: 's1', exists: false }],
    cohorts: [], datasets: [], pipeline: [],
    readmeChanged: false,
    ...over,
  }) as never

  const sel = (over: Partial<Record<string, unknown>> = {}) => ({
    dashboards: new Set<string>(), scripts: new Set<string>(), cohorts: new Set<string>(),
    datasets: new Set<string>(), pipeline: new Set<string>(), readme: false,
    ...over,
  }) as never

  it('is false when an offered item was left out', () => {
    // The anchor must not move: the un-taken script would never be offered again.
    expect(isCompleteProjectPull(
      plan(), sel({ dashboards: new Set(['d1']) }),
    )).toBe(false)
  })

  it('is true once every offered item was taken', () => {
    expect(isCompleteProjectPull(
      plan(), sel({ dashboards: new Set(['d1']), scripts: new Set(['s1']) }),
    )).toBe(true)
  })

  it('is false when the readme block was offered but declined', () => {
    expect(isCompleteProjectPull(
      plan({ readmeChanged: true }),
      sel({ dashboards: new Set(['d1']), scripts: new Set(['s1']) }),
    )).toBe(false)
  })

  it('is true for an empty plan — the "nothing to pull" anchor still works', () => {
    expect(isCompleteProjectPull(
      plan({ dashboards: [], scripts: [] }), sel(),
    )).toBe(true)
  })
})
