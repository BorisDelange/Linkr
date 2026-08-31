import { describe, it, expect } from 'vitest'
import {
  buildProjectPullPlan,
  projectGroupForPath,
  PROJECT_DOCS_FILE,
  PROJECT_GROUP_PATHS,
} from './project-pull-plan-builder'
import { isCompletePull, isFullyReviewed, itemId, type PullDecision } from './pull-plan'
import type { PreparedProjectPull, ProjectPullPlan } from './project-pull'

const emptyPlan = (): ProjectPullPlan => ({
  dashboards: [], patientDashboards: [], scripts: [], cohorts: [], datasets: [],
  pipeline: [], readmeChanged: false,
})

const prepared = (over: Partial<ProjectPullPlan> = {}): PreparedProjectPull => ({
  parsed: {} as never,
  plan: { ...emptyPlan(), ...over },
  clonedOid: 'oid-1',
  branch: 'main',
  localScriptContent: new Map(),
  localExportShape: { cohorts: new Map(), pipeline: new Map() },
  remoteExportShape: { cohorts: new Map(), pipeline: new Map() },
})

describe('buildProjectPullPlan', () => {
  it('gives each GROUP one row carrying its entities, not one row per entity', () => {
    // Sixty scripts must not push the README off the panel: the folder is the
    // handle, the entities inside it are what the user ticks.
    const plan = buildProjectPullPlan(prepared({
      dashboards: [{ key: 'overview', label: 'Overview', exists: false }],
      scripts: [
        { key: 'a.sql', label: 'a.sql', exists: false },
        { key: 'b.sql', label: 'b.sql', exists: true },
      ],
    }), 'main')

    const dashboards = plan.files.find((f) => f.path === PROJECT_GROUP_PATHS.dashboards)!
    const scripts = plan.files.find((f) => f.path === PROJECT_GROUP_PATHS.scripts)!
    expect(dashboards.items).toHaveLength(1)
    expect(scripts.items.map((i) => i.key)).toEqual(['a.sql', 'b.sql'])
    expect(scripts.items[0].state).toBe('add')
    expect(scripts.items[1].state).toBe('update')
  })

  it('drops groups with nothing coming in', () => {
    const plan = buildProjectPullPlan(prepared({
      cohorts: [{ key: 'sepsis', label: 'Sepsis', exists: false }],
    }), 'main')
    expect(plan.files.map((f) => f.path)).toEqual([PROJECT_GROUP_PATHS.cohorts])
  })

  it('offers a picker only when a group holds more than one entity', () => {
    const plan = buildProjectPullPlan(prepared({
      cohorts: [{ key: 'a', label: 'a', exists: false }],
      scripts: [{ key: 'x', label: 'x', exists: false }, { key: 'y', label: 'y', exists: false }],
    }), 'main')
    expect(plan.files.find((f) => f.path === PROJECT_GROUP_PATHS.cohorts)!.pickable).toBe(false)
    expect(plan.files.find((f) => f.path === PROJECT_GROUP_PATHS.scripts)!.pickable).toBe(true)
  })

  it('carries the readme/licence block as one item on its own row', () => {
    const plan = buildProjectPullPlan(prepared({ readmeChanged: true }), 'main')
    const docs = plan.files.find((f) => f.path === PROJECT_DOCS_FILE)!
    expect(docs.items).toHaveLength(1)
  })

  it('maps a row path back to its group, so the apply knows what to write', () => {
    expect(projectGroupForPath(PROJECT_GROUP_PATHS.datasets)).toBe('datasets')
    // The docs row is NOT a group — it writes the entity's own fields.
    expect(projectGroupForPath(PROJECT_DOCS_FILE)).toBeNull()
  })

  it('separates "decided everything" from "took everything" — the two cursors', () => {
    const plan = buildProjectPullPlan(prepared({
      dashboards: [{ key: 'a', label: 'a', exists: false }, { key: 'b', label: 'b', exists: true }],
    }), 'main')
    const decisions = new Map<string, PullDecision>()
    const dashboards = plan.files[0]
    decisions.set(itemId(dashboards, dashboards.items[0]), 'accept')
    decisions.set(itemId(dashboards, dashboards.items[1]), 'decline')

    expect(isFullyReviewed(plan, decisions)).toBe(true)
    expect(isCompletePull(plan, decisions)).toBe(false)
  })
})
