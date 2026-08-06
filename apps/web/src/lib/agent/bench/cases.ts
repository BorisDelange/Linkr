/**
 * The copilot's test battery, shared by the CLI bench and the in-app Tests tab.
 *
 * Each case is a CAPABILITY with the same request written in both languages, and
 * a check on the resulting dashboard STATE — not on which tools were called or in
 * what order, since several routes reach the same result and all are correct.
 *
 * The language is chosen at run time (the app's current language by default)
 * rather than baked into the case list: the app is FR/EN, a model can be markedly
 * weaker in one of them, and what a user wants to know is "does it work in the
 * language I type in".
 *
 * Cases come from failures actually observed: columns referenced by name instead
 * of id, lowercase titles, models inventing a tool, and vague column wording.
 */
import type { DatasetColumn, LocalizedString } from '@/types'

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

export type BenchLang = 'fr' | 'en'

export interface BenchCase {
  id: string
  surface: BenchSurface
  /** Human-readable name, shown in the results table. */
  label: LocalizedString
  /** The same request in each language. */
  prompt: Record<BenchLang, string>
  /**
   * In the smoke run: one case per capability. The excluded cases are the ones
   * needing a two-step plan (look something up, then act) or fine detail — which
   * is exactly where small models fail, so they belong to the full run.
   */
  quick?: boolean
  seed?: (state: BenchState) => void
  /** null = pass; a string explains the failure. */
  check: (state: BenchState, lang: BenchLang) => string | null
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
    id: 'create-tab',
    surface: 'dashboard',
    quick: true,
    label: { en: 'Create a tab', fr: 'Créer un onglet' },
    prompt: {
      fr: 'Ajoute un onglet Cardiologie',
      en: 'Add a tab called Cardiology',
    },
    check: (state, lang) => {
      const expected = lang === 'fr' ? 'Cardiologie' : 'Cardiology'
      const tab = tabNamed(state, expected)
      if (!tab) {
        return `no tab named ${expected} (got: ${state.tabs.map((t) => t.name).join(', ')})`
      }
      return tab.name === expected ? null : `not capitalised: "${tab.name}"`
    },
  },
  {
    id: 'capitalise-title',
    surface: 'dashboard',
    label: { en: 'Capitalise the title', fr: 'Mettre la majuscule' },
    prompt: {
      fr: 'crée un onglet nommé pneumologie',
      en: 'create a tab named pulmonology',
    },
    check: (state, lang) => {
      const typed = lang === 'fr' ? 'pneumologie' : 'pulmonology'
      const tab = tabNamed(state, typed)
      if (!tab) return `no tab named ${typed}`
      const expected = typed.charAt(0).toUpperCase() + typed.slice(1)
      return tab.name === expected ? null : `not capitalised: "${tab.name}"`
    },
  },
  {
    id: 'tab-plus-widget',
    surface: 'dashboard',
    quick: true,
    label: { en: 'Tab with a histogram', fr: 'Onglet avec un histogramme' },
    prompt: {
      fr: 'Ajoute un onglet Néonatologie, avec un histogramme de la distribution de ga_weeks',
      en: 'Add a tab called Neonatology, with a histogram of the ga_weeks distribution',
    },
    check: (state, lang) => {
      const expected = lang === 'fr' ? 'Néonatologie' : 'Neonatology'
      const tab = tabNamed(state, expected)
      if (!tab) return `no tab named ${expected}`
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
    id: 'vague-column',
    surface: 'dashboard',
    quick: true,
    // The wording matches the column LABEL, not its name — the realistic case.
    label: { en: 'Vaguely named column', fr: 'Colonne nommée vaguement' },
    prompt: {
      fr: "Ajoute un histogramme de l'âge gestationnel",
      en: 'Add a histogram of gestational age',
    },
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config
      return config.xColumn === 'col_ga_weeks' ? null : `xColumn=${String(config.xColumn)}`
    },
  },
  {
    id: 'scatter-two-columns',
    surface: 'dashboard',
    label: { en: 'Scatter of two columns', fr: 'Nuage de points à deux colonnes' },
    prompt: {
      fr: "Fais un nuage de points du poids de naissance en fonction de l'âge gestationnel",
      en: 'Make a scatter plot of birth weight against gestational age',
    },
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
    id: 'two-widgets-one-request',
    surface: 'dashboard',
    label: { en: 'Two widgets at once', fr: 'Deux widgets d’un coup' },
    prompt: {
      fr: 'Crée un onglet Qualité avec deux widgets : un histogramme du score Apgar à 5 minutes, et un histogramme du poids de naissance',
      en: 'Create a tab called Quality with two widgets: a histogram of the Apgar score at 5 minutes, and a histogram of birth weight',
    },
    check: (state, lang) => {
      const expected = lang === 'fr' ? 'Qualité' : 'Quality'
      const tab = tabNamed(state, expected)
      if (!tab) return `no tab named ${expected}`
      const widgets = widgetsIn(state, tab.id)
      if (widgets.length < 2) return `only ${widgets.length} widget(s)`
      const columns = widgets.map((w) => w.config.xColumn).sort()
      const wanted = ['col_apgar_5min', 'col_birthweight_g']
      return JSON.stringify(columns) === JSON.stringify(wanted)
        ? null
        : `columns=${JSON.stringify(columns)}`
    },
  },
  {
    id: 'half-width-layout',
    surface: 'dashboard',
    label: { en: 'Half-width layout', fr: 'Mise en page sur la moitié' },
    prompt: {
      fr: "Ajoute un histogramme de ga_weeks qui prend la moitié gauche de l'écran",
      en: 'Add a histogram of ga_weeks taking the left half of the screen',
    },
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const { layout } = state.widgets[0]
      if (layout.w !== 6) return `w=${layout.w}`
      return layout.x === 0 ? null : `x=${layout.x}`
    },
  },
  {
    id: 'delete-tab',
    surface: 'dashboard',
    quick: true,
    label: { en: 'Delete a tab', fr: 'Supprimer un onglet' },
    seed: (state) => state.tabs.push({ id: 'tab_seed', name: 'Test' }),
    prompt: {
      fr: "Supprime l'onglet Test",
      en: 'Delete the Test tab',
    },
    // A correct run stops at the confirmation rather than deleting.
    check: (state) => {
      if (state.pending?.tool === 'remove_tab') return null
      return tabNamed(state, 'Test') ? 'tab still present, no confirmation asked' : null
    },
  },
  {
    id: 'delete-widget',
    surface: 'dashboard',
    label: { en: 'Delete a widget', fr: 'Supprimer un widget' },
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
    prompt: {
      fr: 'Supprime le widget Lactates',
      en: 'Delete the Lactates widget',
    },
    check: (state) =>
      state.pending?.tool === 'remove_widget'
        ? null
        : 'no confirmation requested for the widget deletion',
  },
  {
    id: 'refuse-out-of-scope',
    surface: 'dashboard',
    quick: true,
    label: { en: 'Refuse an impossible request', fr: 'Refuser une demande impossible' },
    prompt: {
      fr: 'Supprime tous les patients de plus de 80 ans de la base',
      en: 'Delete every patient older than 80 from the database',
    },
    // Small models grab the nearest tool here; nothing must move.
    check: (state) => {
      if (state.tabs.length !== 1) return 'created or removed a tab'
      if (state.widgets.length) return 'created a widget'
      if (state.pending) return `asked to confirm ${state.pending.tool}`
      return null
    },
  },
  {
    id: 'answer-question',
    surface: 'dashboard',
    label: { en: 'Answer without acting', fr: 'Répondre sans agir' },
    prompt: {
      fr: 'Que peux-tu faire ?',
      en: 'What can you do?',
    },
    check: (state) => {
      if (state.tabs.length !== 1 || state.widgets.length) return 'changed the dashboard'
      return state.replyText.trim() ? null : 'no answer given'
    },
  },
]

/** The short run: one case per capability, skipping the two-step ones. */
export const QUICK_CASES = BENCH_CASES.filter((benchCase) => benchCase.quick)

/** Cases for the chosen surfaces, optionally limited to the quick subset. */
export function selectCases(
  surfaces: BenchSurface[],
  mode: 'quick' | 'full'
): BenchCase[] {
  const pool = mode === 'quick' ? QUICK_CASES : BENCH_CASES
  return pool.filter((benchCase) => surfaces.includes(benchCase.surface))
}
