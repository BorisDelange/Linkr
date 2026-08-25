import { describe, it, expect } from 'vitest'
import { collectWorkspaceBadges, countForCategory, renameBadgeCategory } from './badge-category-rename'
import type { Storage } from '@/lib/storage'
import type { BadgeCategory, ProjectBadge } from '@/types'

const WS = 'ws1'
const badge = (id: string, label: string): ProjectBadge => ({ id, label: { en: label }, color: 'blue' })

const cat = (name: BadgeCategory['name']): BadgeCategory =>
  ({ id: 'c1', name, color: 'cyan', exclusive: false })
const SOURCE = cat({ en: 'Source' })
const DATASET = cat({ en: 'Dataset' })

/**
 * Minimal in-memory stand-in for the collections the cascade touches. Only the
 * calls it makes are implemented; anything else would be a bug in the cascade.
 */
function fakeStorage() {
  const db = {
    workspace: { id: WS, badges: [badge('w', 'Source::MIMIC')] },
    projects: [
      { uid: 'p1', workspaceId: WS, badges: [badge('a', 'Source::MIMIC'), badge('b', 'urgent')] },
      { uid: 'p2', workspaceId: 'other', badges: [badge('c', 'Source::MIMIC')] },
      { uid: 'p3', workspaceId: WS, badges: [badge('d', 'Domain::ICU')] },
    ],
    dataSources: [{ id: 'ds1', badges: [badge('e', 'Source::eICU')] }],
    etlPipelines: [{ id: 'et1', badges: undefined }],
    sqlScriptCollections: [{ id: 'sc1', badges: [badge('f', 'Source::MIMIC')] }],
    dqRuleSets: [{ id: 'dq1', badges: [] }],
    schemaPresets: [{ presetId: 'sp1', badges: [badge('g', 'Source::MIMIC')] }],
  }

  const patch = <T extends object>(row: T, changes: Partial<T>) => Object.assign(row, changes)

  const storage = {
    workspaces: {
      getById: async (id: string) => (id === WS ? db.workspace : undefined),
      update: async (_id: string, c: object) => { patch(db.workspace, c) },
    },
    projects: {
      getAll: async () => db.projects,
      update: async (uid: string, c: object) => { patch(db.projects.find((p) => p.uid === uid)!, c) },
    },
    dataSources: {
      getByWorkspace: async () => db.dataSources,
      update: async (id: string, c: object) => { patch(db.dataSources.find((d) => d.id === id)!, c) },
    },
    etlPipelines: {
      getByWorkspace: async () => db.etlPipelines,
      update: async () => { throw new Error('should not update a pipeline with no badges') },
    },
    sqlScriptCollections: {
      getByWorkspace: async () => db.sqlScriptCollections,
      update: async (id: string, c: object) => { patch(db.sqlScriptCollections.find((s) => s.id === id)!, c) },
    },
    dqRuleSets: {
      getByWorkspace: async () => db.dqRuleSets,
      update: async () => { throw new Error('should not update a rule set with no badges') },
    },
    schemaPresets: {
      getByWorkspace: async () => db.schemaPresets,
      save: async (p: (typeof db.schemaPresets)[number]) => {
        db.schemaPresets = db.schemaPresets.map((x) => (x.presetId === p.presetId ? p : x))
      },
    },
  } as unknown as Storage

  return { storage, db }
}

const labels = (badges: ProjectBadge[] | undefined) =>
  (badges ?? []).map((b) => (typeof b.label === 'string' ? b.label : b.label.en))

describe('renameBadgeCategory', () => {
  it('rewrites the prefix across every collection in the workspace', async () => {
    const { storage, db } = fakeStorage()
    const changed = await renameBadgeCategory(storage, WS, SOURCE, DATASET)

    expect(labels(db.workspace.badges)).toEqual(['Dataset::MIMIC'])
    expect(labels(db.projects[0].badges)).toEqual(['Dataset::MIMIC', 'urgent'])
    expect(labels(db.dataSources[0].badges)).toEqual(['Dataset::eICU'])
    expect(labels(db.sqlScriptCollections[0].badges)).toEqual(['Dataset::MIMIC'])
    expect(labels(db.schemaPresets[0].badges)).toEqual(['Dataset::MIMIC'])
    // workspace + p1 + ds1 + sc1 + sp1
    expect(changed).toBe(5)
  })

  it('leaves another workspace untouched', async () => {
    const { storage, db } = fakeStorage()
    await renameBadgeCategory(storage, WS, SOURCE, DATASET)
    expect(labels(db.projects[1].badges)).toEqual(['Source::MIMIC'])
  })

  it('leaves other categories and loose badges untouched', async () => {
    const { storage, db } = fakeStorage()
    await renameBadgeCategory(storage, WS, SOURCE, DATASET)
    expect(labels(db.projects[2].badges)).toEqual(['Domain::ICU'])
    expect(labels(db.projects[0].badges)).toContain('urgent')
  })

  it('does not write an entity whose badges did not change', async () => {
    // The two stubs that throw on update are the assertion: an entity with no
    // matching badge must never be written.
    const { storage } = fakeStorage()
    await expect(renameBadgeCategory(storage, WS, SOURCE, DATASET)).resolves.toBeGreaterThan(0)
  })

  it('is a no-op when nothing carries the category', async () => {
    const { storage, db } = fakeStorage()
    const ghost = cat({ en: 'Ghost' })
    expect(await renameBadgeCategory(storage, WS, ghost, cat({ en: 'Spectre' }))).toBe(0)
    expect(labels(db.workspace.badges)).toEqual(['Source::MIMIC'])
  })

  it('gives the badge a prefix in a language it did not have', async () => {
    // The rename is where a badge written in one language only picks up the
    // other one's prefix — that is what makes it render scoped in both.
    const { storage, db } = fakeStorage()
    await renameBadgeCategory(storage, WS, SOURCE, cat({ en: 'Dataset', fr: 'Jeu de données' }))
    expect(db.workspace.badges[0].label).toEqual({
      en: 'Dataset::MIMIC',
      fr: 'Jeu de données::MIMIC',
    })
  })
})

describe('collectWorkspaceBadges', () => {
  it('gathers badges from every collection, skipping other workspaces', async () => {
    const { storage } = fakeStorage()
    const all = await collectWorkspaceBadges(storage, WS)
    // Source::MIMIC four times: workspace, project p1, sql collection, schema preset.
    expect(labels(all).sort()).toEqual(
      [
        'Domain::ICU',
        'Source::MIMIC', 'Source::MIMIC', 'Source::MIMIC', 'Source::MIMIC',
        'Source::eICU',
        'urgent',
      ].sort(),
    )
  })
})

describe('countForCategory', () => {
  it('counts badges carrying the category prefix', () => {
    const badges = [badge('a', 'Source::MIMIC'), badge('b', 'Source::eICU'), badge('c', 'Domain::ICU')]
    expect(countForCategory(badges, SOURCE)).toBe(2)
  })

  it('matches case-insensitively', () => {
    expect(countForCategory([badge('a', 'SOURCE::MIMIC')], cat({ en: 'source' }))).toBe(1)
  })

  it('does not count a name that merely starts the same', () => {
    expect(countForCategory([badge('a', 'Sourcery::x')], SOURCE)).toBe(0)
  })

  it('counts a badge whose prefix is written in another language of the category', () => {
    const fr: ProjectBadge = { id: 'a', label: { fr: 'Origine::MIMIC' }, color: 'blue' }
    expect(countForCategory([fr], cat({ en: 'Source', fr: 'Origine' }))).toBe(1)
  })

  it('counts a bilingual badge once', () => {
    const both: ProjectBadge = {
      id: 'a',
      label: { en: 'Source::MIMIC', fr: 'Origine::MIMIC' },
      color: 'blue',
    }
    expect(countForCategory([both], cat({ en: 'Source', fr: 'Origine' }))).toBe(1)
  })
})
