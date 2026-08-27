import { describe, expect, it } from 'vitest'
import { META_FILE, freshId, idOf, isSameEntity, resolveInstallIdentity, type ExistingRow } from './install'
import { ENTRY_TYPES, type CatalogEntry } from './types'

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'e1',
    type: 'etl-pipeline',
    name: { en: 'Pipeline' },
    git: { url: 'https://gitlab.com/org/pipeline', branch: 'main' },
    ...overrides,
  } as CatalogEntry
}

describe('isSameEntity', () => {
  it('matches on a shared lineageId', () => {
    const row: ExistingRow = { lineageId: 'lin-1' }
    expect(isSameEntity(row, entry({ lineageId: 'lin-1' }))).toBe(true)
  })

  it('matches on the same git remote (normalised)', () => {
    const row: ExistingRow = { gitRemoteConfig: { url: 'https://gitlab.com/org/pipeline/-/tree/main' } }
    expect(isSameEntity(row, entry())).toBe(true)
  })

  it('does NOT match when only the id would collide (no lineage, no remote)', () => {
    // The dangerous case: an unrelated local row that merely shares the declared id.
    const row: ExistingRow = { name: { en: "Victim's pipeline" } }
    expect(isSameEntity(row, entry())).toBe(false)
  })

  it('does NOT match a different lineage or a different remote', () => {
    expect(isSameEntity({ lineageId: 'other' }, entry({ lineageId: 'lin-1' }))).toBe(false)
    expect(
      isSameEntity({ gitRemoteConfig: { url: 'https://gitlab.com/org/OTHER' } }, entry()),
    ).toBe(false)
  })
})

describe('idOf', () => {
  // Regression: buildProjectZip writes `projectId` and deliberately drops `uid`
  // (the local PK churns the diff). Reading only `uid` returned null, the caller
  // fell back to a random uuid, and every re-install of the same project created a
  // duplicate instead of being recognised as already installed.
  it('reads a project id from projectId', () => {
    expect(idOf('project', { projectId: 'icu-activity-dashboard' })).toBe('icu-activity-dashboard')
  })

  it('still reads uid, for repos exported before the switch', () => {
    expect(idOf('project', { uid: 'legacy-uid' })).toBe('legacy-uid')
  })

  it('prefers projectId when a repo carries both', () => {
    expect(idOf('project', { projectId: 'portable', uid: 'local-pk' })).toBe('portable')
  })

  it('reads presetId for a schema preset and id for everything else', () => {
    expect(idOf('schema-preset', { presetId: 'omop-cdm-5-4' })).toBe('omop-cdm-5-4')
    expect(idOf('etl-pipeline', { id: 'pipe-1' })).toBe('pipe-1')
  })

  it('returns null when the id is missing or not a non-empty string', () => {
    expect(idOf('project', {})).toBeNull()
    expect(idOf('project', { projectId: '' })).toBeNull()
    expect(idOf('etl-pipeline', { id: 42 })).toBeNull()
  })
})

describe('isSameEntity, for a repo that publishes no lineageId', () => {
  // The published schema repos carry neither lineageId nor gitRemoteConfig (those are
  // instance fields, stripped on export), so identity rests on the git URL the install
  // stamps locally. A row predating that stamping matches nothing — which is why a
  // re-install of OMOP CDM 5.4 read as an unrelated collision and minted a fresh id.
  const schema = entry({ type: 'schema-preset', git: { url: 'https://framagit.org/g/omop-cdm-5.4', branch: 'main' } })

  it('matches a row the install stamped with the same remote', () => {
    expect(isSameEntity({ gitRemoteConfig: { url: 'https://framagit.org/g/omop-cdm-5.4.git' } }, schema)).toBe(true)
  })

  it('does NOT match a row carrying no remote at all', () => {
    // Documents the real limitation: such a row is indistinguishable from an unrelated
    // entity that happens to share the id, and overwriting it would destroy user data.
    expect(isSameEntity({ workspaceId: 'ws-1' }, schema)).toBe(false)
  })
})

describe('resolveInstallIdentity', () => {
  it('reuses the repo id for a first install into an empty workspace', () => {
    expect(resolveInstallIdentity({ idCollision: false }, false)).toEqual({
      reuseId: true,
      renameAsCopy: false,
    })
  })

  it('reuses the repo id to update the same entity already in this workspace', () => {
    expect(
      resolveInstallIdentity({ idCollision: true, existingName: 'ICU Activity Dashboard' }, false),
    ).toEqual({ reuseId: true, renameAsCopy: false })
  })

  it('mints a fresh id and marks a copy when the user keeps both side by side', () => {
    expect(
      resolveInstallIdentity({ idCollision: true, existingName: 'ICU Activity Dashboard' }, true),
    ).toEqual({ reuseId: false, renameAsCopy: true })
  })

  it('mints a fresh id but does NOT mark a copy when the id is held by another workspace', () => {
    // The regression: installing a project already present in ANOTHER workspace has
    // to take a fresh local id (the other row owns the repo's, and reusing it made
    // the shell insert violate the uid primary key — a 409), but this workspace shows
    // exactly one row, so "(copy)" named a sibling that isn't there.
    expect(
      resolveInstallIdentity({ idCollision: true, collisionElsewhere: true }, false),
    ).toEqual({ reuseId: false, renameAsCopy: false })
  })

  it('still marks a copy when the id is held elsewhere AND the user asked to duplicate', () => {
    expect(
      resolveInstallIdentity({ idCollision: true, collisionElsewhere: true }, true),
    ).toEqual({ reuseId: false, renameAsCopy: true })
  })

  it('never reuses an id held by an unrelated local entity, whatever the caller asked', () => {
    // No existingName = isSameEntity said no. Overwriting would destroy user data.
    expect(resolveInstallIdentity({ idCollision: true }, false).reuseId).toBe(false)
  })
})

describe('freshId', () => {
  // A preset's id is its user-facing Identifier (it fills that field and rides in the
  // URL), so a duplicate install used to put a 36-char uuid in front of the user.
  it('mints a short readable slug for a schema preset', () => {
    const id = freshId('schema-preset')
    expect(id).toMatch(/^custom-[0-9a-f]{8}$/)
  })

  it('keeps an opaque uuid for the types whose id the user never sees', () => {
    for (const type of ['project', 'etl-pipeline', 'mapping-project'] as const) {
      expect(freshId(type)).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 50 }, () => freshId('schema-preset')))
    expect(ids.size).toBe(50)
  })
})

// The catalog reads an installed entity's own id out of its repo's root manifest.
// This table used to be a hand-typed copy of the export layout and had drifted:
// it expected `_project.json` for a mapping project, while the exporter writes
// `project.json`, so every freshly published mapping project installed with no
// id (and so could never be recognised as already installed).
describe('META_FILE', () => {
  it('looks for a mapping project under the name the exporter actually writes', () => {
    expect(META_FILE['mapping-project']).toContain('project.json')
  })

  it('still accepts the legacy mapping-project name', () => {
    expect(META_FILE['mapping-project']).toContain('_project.json')
  })

  it('names every type the catalog can install', () => {
    // Iterating ENTRY_TYPES, not META_FILE's own keys: a type published without a
    // manifest name installs with no id, so it can never be recognised as already
    // installed — and looping over the table itself would never notice the gap.
    for (const type of ENTRY_TYPES) {
      const candidates = META_FILE[type]
      expect(candidates, type).toBeDefined()
      expect(candidates.length, type).toBeGreaterThan(0)
      expect(candidates.every((c) => c.endsWith('.json')), type).toBe(true)
    }
  })
})
