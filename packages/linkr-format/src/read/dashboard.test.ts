/**
 * The acceptance gate for read-modify-write: a dashboard the APP wrote must come
 * back through `readDashboard` → `serializeProject` byte for byte.
 *
 * This is the test the whole passthrough design exists to satisfy. A spec is a
 * simplified authoring view — it models a name and a plugin, while the app also
 * stores `widgetSpacing`, `fitToHeight`, `version`, `createdByDetails`, a filter's
 * `scope`… Reading into a spec that cannot hold those and writing back would
 * DELETE them, silently, on a tree the user never asked to change. The absence of
 * a read tool merely blocks; a lossy one destroys, which is why this gate comes
 * before any mutator.
 *
 * The fixture is the app's own golden export, so this also pins the two writers
 * together: if `entity-io.ts` starts emitting a field, the round trip fails here
 * rather than in a user's git diff.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serializeProject, type ProjectSpec } from '../serialize/project.js'
import { readDashboard, type DashboardFile } from './dashboard.js'

const GOLDEN = fileURLToPath(new URL(
  '../../../../apps/web/src/lib/__fixtures__/export-golden/project/expected/dashboards/overview.json',
  import.meta.url,
))

const raw = readFileSync(GOLDEN, 'utf-8')
const file = JSON.parse(raw) as DashboardFile

/** The datasets the golden's widgets and filters point at, so ids re-resolve. */
const CSV = 'patient_id,age,sex\n1,60,M\n'

function reserialize(spec: ReturnType<typeof readDashboard>): string {
  const project: ProjectSpec = {
    projectId: 'golden',
    name: { en: 'Golden' },
    appVersion: '2.3.3',
    datasets: [{ name: 'cohort', csv: CSV }],
    dashboards: [spec],
  }
  const out = serializeProject(project).find((f) => f.path.startsWith('dashboards/'))
  if (!out) throw new Error('no dashboard file emitted')
  return out.content
}

describe('readDashboard', () => {
  it('round-trips the app\'s golden dashboard byte for byte', () => {
    // The gate. Not "structurally equivalent" — identical, because the export is
    // compared byte for byte and a moved key is a git diff on an untouched tree.
    expect(reserialize(readDashboard(file))).toBe(raw)
  })

  it('keeps the fields the spec has no notion of', () => {
    const spec = readDashboard(file)
    // These are real user configuration, not noise: dropping widgetSpacing resets
    // the user's grid, dropping version loses their release marker.
    expect(spec.extra).toMatchObject({
      defaultDatasetFileId: null,
      widgetSpacing: 8,
      reloadWidgetsOnTabSwitch: false,
      fitToHeight: false,
      createdBy: 'Ada Lovelace',
      version: '0.1.0',
    })
  })

  it('keeps a filter\'s scope, which points at tabs and widgets by key', () => {
    // The referential one: `scope` names the very keys a rename or a move would
    // change, so it is both the easiest field to lose and the one whose loss is
    // hardest to notice — the filter silently widens to the whole dashboard.
    const spec = readDashboard(file)
    expect(spec.filters?.[0].scope).toEqual({ type: 'tabs', tabKeys: ['overview/summary'] })
    expect(spec.filters?.[1].scope).toEqual({
      type: 'widgets',
      widgetKeys: ['overview/summary/kpi@0,0'],
    })
  })

  it('addresses tabs and widgets by name, not by key', () => {
    // What makes the spec editable: an agent renames a tab by saying its name.
    const spec = readDashboard(file)
    expect(spec.tabs.map((t) => t.name.en)).toContain('Summary')
    expect(spec.widgets?.[0].tab).toBe('Summary')
  })

  it('round-trips a dashboard with no filters and several widgets', () => {
    // The golden has exactly one dashboard; this covers the other common shape —
    // several widgets, no filterConfig — which is what the published
    // icu-activity-dashboard looks like. Kept as a literal rather than reading
    // that repo, so the test does not depend on a sibling checkout.
    const file: DashboardFile = {
      dashboard: {
        name: { en: 'Activity' },
        description: null,
        filterConfig: [],
        showWidgetTitles: false,
        widgetSpacing: 12,
        gridV: 2,
        version: '1.0.0',
      },
      tabs: [
        { name: { en: 'Main' }, description: null, displayOrder: 0, key: 'activity/main', parentKey: null },
      ],
      widgets: [
        {
          name: { en: 'Beds' },
          description: null,
          datasetFileId: 'icu.csv',
          layout: { x: 0, y: 0, w: 12, h: 8 },
          source: { type: 'plugin', pluginId: 'kpi', config: { column: 'col_beds' } },
          key: 'activity/main/beds@0,0',
          tabKey: 'activity/main',
        },
        {
          name: { en: 'Trend' },
          description: null,
          datasetFileId: 'icu.csv',
          layout: { x: 12, y: 0, w: 12, h: 8 },
          source: { type: 'plugin', pluginId: 'line', config: {} },
          key: 'activity/main/trend@0,12',
          tabKey: 'activity/main',
        },
      ],
    }
    const spec = readDashboard(file)
    const out = serializeProject({
      projectId: 'p',
      name: { en: 'P' },
      appVersion: '2.3.3',
      datasets: [{ name: 'icu', csv: 'beds\n4\n' }],
      dashboards: [spec],
    }).find((f) => f.path.startsWith('dashboards/'))!
    expect(out.content).toBe(JSON.stringify(file, null, 2))
  })

  it('leaves no extra on a record that carries nothing beyond the spec', () => {
    // A hand-authored spec must not gain empty `extra` objects, or every example
    // in the skill's references stops matching what a read returns.
    const spec = readDashboard({
      dashboard: { name: { en: 'D' }, description: null, filterConfig: [], gridV: 2 },
      tabs: [{ name: { en: 'T' }, description: null, displayOrder: 0, key: 'd/t', parentKey: null }],
      widgets: [],
    })
    expect(spec.extra).toBeUndefined()
    expect(spec.tabs[0].extra).toBeUndefined()
  })

  it('refuses two sibling tabs that share an English name', () => {
    // A spec addresses tabs by name, so both would serialize back to one key and
    // the second would overwrite the first on import, taking its widgets.
    expect(() => readDashboard({
      dashboard: { name: { en: 'D' } },
      tabs: [
        { name: { en: 'T' }, key: 'd/t', parentKey: null, displayOrder: 0 },
        { name: { en: 'T' }, key: 'd/t#1', parentKey: null, displayOrder: 1 },
      ],
      widgets: [],
    })).toThrow(/Two tabs named "T"/)
  })

  it('allows the same tab name under different parents', () => {
    // Only siblings are ambiguous: the parent qualifies the key, and a spec names
    // the parent too, so these round-trip fine.
    const spec = readDashboard({
      dashboard: { name: { en: 'D' } },
      tabs: [
        { name: { en: 'Parent' }, key: 'd/parent', parentKey: null, displayOrder: 0 },
        { name: { en: 'T' }, key: 'd/t', parentKey: null, displayOrder: 1 },
        { name: { en: 'T' }, key: 'd/parent/t', parentKey: 'd/parent', displayOrder: 2 },
      ],
      widgets: [],
    })
    expect(spec.tabs).toHaveLength(3)
    expect(spec.tabs[2].parent).toBe('Parent')
  })
})
