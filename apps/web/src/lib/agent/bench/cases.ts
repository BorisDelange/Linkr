/**
 * The copilot's test battery, shared by the CLI bench and the in-app Tests tab.
 *
 * Each case is a user request plus a check on the resulting dashboard STATE, not
 * on which tools were called or in what order — several routes reach the same
 * result and all are correct, so asserting the route would fail good models for
 * cosmetic reasons.
 *
 * Cases are drawn from failures actually observed: column references by name
 * instead of id, lowercase titles, models inventing a tool, ambiguous column
 * wording, and the same request in French and English.
 */
import type { DatasetColumn } from '@/types'

export interface BenchTab {
  id: string
  name: string
}

export interface BenchWidget {
  id: string
  tabId: string
  name: string
  datasetFileId?: string | null
  config: Record<string, unknown>
  layout: { x: number; y: number; w: number; h: number }
}

/** The simulated dashboard a case runs against. */
export interface BenchState {
  dashboardName: string
  tabs: BenchTab[]
  widgets: BenchWidget[]
  activeTabId: string | null
  datasets: {
    id: string
    name: string
    rowCount?: number
    columns: DatasetColumn[]
  }[]
  pending: { tool: string } | null
  replyText: string
}

/**
 * Which assistant surface a case belongs to. Only 'dashboard' exists today; the
 * copilot is meant to reach datasets, the IDE and script collections, and each
 * will bring its own tools and therefore its own cases.
 */
export type BenchSurface = 'dashboard'

export const BENCH_SURFACES: BenchSurface[] = ['dashboard']

export interface BenchCase {
  id: string
  surface: BenchSurface
  lang: 'fr' | 'en'
  /** Included in the short "quick check" run. */
  quick?: boolean
  prompt: string
  seed?: (state: BenchState) => void
  /** null = pass; a string explains the failure. */
  check: (state: BenchState) => string | null
}

function column(
  id: string,
  name: string,
  type: DatasetColumn['type'],
  order: number,
  extra: Partial<DatasetColumn> = {}
): DatasetColumn {
  return { id, name, type, order, ...extra } as DatasetColumn
}

/**
 * Fixture mirroring a real clinical dataset: opaque column names (`ga_weeks`)
 * with human labels ("Âge gestationnel"). Resolving one to the other is the hard
 * part, and the reason several cases exist.
 */
export function benchFixture(): BenchState {
  return {
    dashboardName: 'CLIP',
    tabs: [{ id: 'tab_overview', name: 'Overview' }],
    widgets: [],
    activeTabId: 'tab_overview',
    datasets: [
      {
        id: 'table_agregee.csv',
        name: 'table_agregee.csv',
        rowCount: 3558,
        columns: [
          column('col_patient_id', 'patient_id', 'number', 0),
          column('col_ga_weeks', 'ga_weeks', 'number', 1, {
            label: 'Âge gestationnel (semaines)',
          }),
          column('col_birthweight_g', 'birthweight_g', 'number', 2, {
            label: 'Poids de naissance (g)',
          }),
          column('col_sex', 'sex', 'string', 3, {
            valueLabels: { M: 'Masculin', F: 'Féminin' },
          }),
          column('col_apgar_5min', 'apgar_5min', 'number', 4, {
            label: 'Apgar à 5 minutes',
          }),
          column('col_death_status', 'death_status', 'boolean', 5),
        ],
      },
    ],
    pending: null,
    replyText: '',
  }
}

const tabNamed = (state: BenchState, name: string) =>
  state.tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase())

const widgetsIn = (state: BenchState, tabId: string) =>
  state.widgets.filter((widget) => widget.tabId === tabId)

export const BENCH_CASES: BenchCase[] = [
  {
    id: 'create-tab-fr',
    surface: 'dashboard',
    lang: 'fr',
    quick: true,
    prompt: 'Ajoute un onglet Cardiologie',
    check: (state) => {
      const tab = tabNamed(state, 'Cardiologie')
      if (!tab) {
        return `no tab named Cardiologie (got: ${state.tabs.map((t) => t.name).join(', ')})`
      }
      return tab.name === 'Cardiologie' ? null : `not capitalised: "${tab.name}"`
    },
  },
  {
    id: 'create-tab-en',
    surface: 'dashboard',
    lang: 'en',
    prompt: 'Add a tab called Cardiology',
    check: (state) => (tabNamed(state, 'Cardiology') ? null : 'no tab named Cardiology'),
  },
  {
    id: 'create-tab-lowercase',
    surface: 'dashboard',
    lang: 'fr',
    prompt: 'crée un onglet nommé pneumologie',
    check: (state) => {
      const tab = tabNamed(state, 'pneumologie')
      if (!tab) return 'no tab named pneumologie'
      return tab.name === 'Pneumologie' ? null : `not capitalised: "${tab.name}"`
    },
  },
  {
    id: 'tab-plus-widget-explicit-column',
    surface: 'dashboard',
    lang: 'fr',
    quick: true,
    prompt: 'Ajoute un onglet Néonatologie, avec un histogramme de la distribution de ga_weeks',
    check: (state) => {
      const tab = tabNamed(state, 'Néonatologie')
      if (!tab) return 'no tab named Néonatologie'
      const widgets = widgetsIn(state, tab.id)
      if (!widgets.length) return 'no widget in the new tab'
      const config = widgets[0].config
      if (config.plotType !== 'histogram') return `plotType=${String(config.plotType)}`
      // A column NAME here leaves the picker empty — the bug that started this.
      if (config.xColumn !== 'col_ga_weeks') return `xColumn=${String(config.xColumn)}`
      return null
    },
  },
  {
    id: 'widget-vague-column-fr',
    surface: 'dashboard',
    lang: 'fr',
    quick: true,
    // "âge gestationnel" matches the LABEL, not the column name.
    prompt: "Ajoute un histogramme de l'âge gestationnel",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config
      return config.xColumn === 'col_ga_weeks' ? null : `xColumn=${String(config.xColumn)}`
    },
  },
  {
    id: 'widget-vague-column-en',
    surface: 'dashboard',
    lang: 'en',
    prompt: 'Add a histogram of gestational age',
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config
      return config.xColumn === 'col_ga_weeks' ? null : `xColumn=${String(config.xColumn)}`
    },
  },
  {
    id: 'widget-scatter-two-columns',
    surface: 'dashboard',
    lang: 'fr',
    prompt: "Fais un nuage de points du poids de naissance en fonction de l'âge gestationnel",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config
      if (config.plotType !== 'scatter') return `plotType=${String(config.plotType)}`
      const columns = [config.xColumn, config.yColumn].sort()
      const expected = ['col_birthweight_g', 'col_ga_weeks']
      return JSON.stringify(columns) === JSON.stringify(expected)
        ? null
        : `columns=${JSON.stringify(columns)}`
    },
  },
  {
    id: 'tab-plus-two-widgets',
    surface: 'dashboard',
    lang: 'fr',
    prompt:
      'Crée un onglet Qualité avec deux widgets : un histogramme du score Apgar à 5 minutes, et un histogramme du poids de naissance',
    check: (state) => {
      const tab = tabNamed(state, 'Qualité')
      if (!tab) return 'no tab named Qualité'
      const widgets = widgetsIn(state, tab.id)
      if (widgets.length < 2) return `only ${widgets.length} widget(s)`
      const columns = widgets.map((w) => w.config.xColumn).sort()
      const expected = ['col_apgar_5min', 'col_birthweight_g']
      return JSON.stringify(columns) === JSON.stringify(expected)
        ? null
        : `columns=${JSON.stringify(columns)}`
    },
  },
  {
    id: 'widget-half-width',
    surface: 'dashboard',
    lang: 'fr',
    prompt: "Ajoute un histogramme de ga_weeks qui prend la moitié gauche de l'écran",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const { layout } = state.widgets[0]
      if (layout.w !== 6) return `w=${layout.w}`
      return layout.x === 0 ? null : `x=${layout.x}`
    },
  },
  {
    id: 'delete-tab-by-name',
    surface: 'dashboard',
    lang: 'fr',
    quick: true,
    seed: (state) => state.tabs.push({ id: 'tab_seed', name: 'Test' }),
    prompt: "Supprime l'onglet Test",
    // A correct run stops at the confirmation rather than deleting.
    check: (state) => {
      if (state.pending?.tool === 'remove_tab') return null
      return tabNamed(state, 'Test') ? 'tab still present, no confirmation asked' : null
    },
  },
  {
    id: 'delete-widget',
    surface: 'dashboard',
    lang: 'fr',
    seed: (state) => {
      state.tabs.push({ id: 'tab_seed', name: 'Labs' })
      state.widgets.push({
        id: 'wid_seed',
        tabId: 'tab_seed',
        name: 'Lactates',
        config: {},
        layout: { x: 0, y: 0, w: 12, h: 8 },
      })
    },
    prompt: 'Supprime le widget Lactates',
    check: (state) =>
      state.pending?.tool === 'remove_widget'
        ? null
        : 'no confirmation requested for the widget deletion',
  },
  {
    id: 'refuse-out-of-scope',
    surface: 'dashboard',
    lang: 'fr',
    quick: true,
    prompt: 'Supprime tous les patients de plus de 80 ans de la base',
    // Small models grab the nearest tool here; nothing must move.
    check: (state) => {
      if (state.tabs.length !== 1) return 'created or removed a tab'
      if (state.widgets.length) return 'created a widget'
      if (state.pending) return `asked to confirm ${state.pending.tool}`
      return null
    },
  },
  {
    id: 'ask-capabilities',
    surface: 'dashboard',
    lang: 'fr',
    prompt: 'Que peux-tu faire ?',
    check: (state) => {
      if (state.tabs.length !== 1 || state.widgets.length) return 'changed the dashboard'
      return state.replyText.trim() ? null : 'no answer given'
    },
  },
]

/** The short run: enough to prove the endpoint works and measure its speed. */
export const QUICK_CASES = BENCH_CASES.filter((benchCase) => benchCase.quick)

/** Cases for the chosen surfaces, optionally limited to the quick subset. */
export function selectCases(
  surfaces: BenchSurface[],
  mode: 'quick' | 'full'
): BenchCase[] {
  const pool = mode === 'quick' ? QUICK_CASES : BENCH_CASES
  return pool.filter((benchCase) => surfaces.includes(benchCase.surface))
}
