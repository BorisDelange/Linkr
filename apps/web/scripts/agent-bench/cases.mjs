/**
 * The test battery for the dashboard copilot.
 *
 * Each case is a user request plus a check on the resulting dashboard STATE, not
 * on which tools were called or in what order — several routes to the same
 * result are all correct, and asserting the route would fail good models for
 * cosmetic reasons.
 *
 * Cases are written to expose the failures we have actually hit: column
 * references by name instead of id, lowercase titles, a model inventing a tool,
 * ambiguous column wording, and the same request in French and English.
 */

/**
 * The fixture dashboard. Column names are deliberately opaque (`ga_weeks`) while
 * labels are human ("Âge gestationnel"), which is the real situation in a
 * clinical dataset and the hard part for a model.
 */
export const FIXTURE = {
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
        { id: 'col_patient_id', name: 'patient_id', type: 'number', order: 0 },
        {
          id: 'col_ga_weeks',
          name: 'ga_weeks',
          type: 'number',
          order: 1,
          label: 'Âge gestationnel (semaines)',
        },
        {
          id: 'col_birthweight_g',
          name: 'birthweight_g',
          type: 'number',
          order: 2,
          label: 'Poids de naissance (g)',
        },
        {
          id: 'col_sex',
          name: 'sex',
          type: 'string',
          order: 3,
          valueLabels: { M: 'Masculin', F: 'Féminin' },
        },
        {
          id: 'col_apgar_5min',
          name: 'apgar_5min',
          type: 'number',
          order: 4,
          label: 'Apgar à 5 minutes',
        },
        { id: 'col_death_status', name: 'death_status', type: 'boolean', order: 5 },
      ],
    },
  ],
}

/** A tab whose name matches, case-insensitively. */
const tabNamed = (state, name) =>
  state.tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase())

const widgetsIn = (state, tabId) => state.widgets.filter((w) => w.tabId === tabId)

export const CASES = [
  // --- Creating -----------------------------------------------------------
  {
    id: 'create-tab-fr',
    lang: 'fr',
    prompt: 'Ajoute un onglet Cardiologie',
    check: (state) => {
      const tab = tabNamed(state, 'Cardiologie')
      if (!tab) return `no tab named Cardiologie (got: ${state.tabs.map((t) => t.name).join(', ')})`
      if (tab.name !== 'Cardiologie') return `not capitalised: "${tab.name}"`
      return null
    },
  },
  {
    id: 'create-tab-en',
    lang: 'en',
    prompt: 'Add a tab called Cardiology',
    check: (state) =>
      tabNamed(state, 'Cardiology') ? null : 'no tab named Cardiology',
  },
  {
    id: 'create-tab-lowercase',
    lang: 'fr',
    // The model echoes the user's casing; the app capitalises. Guards the fix.
    prompt: 'crée un onglet nommé pneumologie',
    check: (state) => {
      const tab = tabNamed(state, 'pneumologie')
      if (!tab) return 'no tab named pneumologie'
      return tab.name === 'Pneumologie' ? null : `not capitalised: "${tab.name}"`
    },
  },

  // --- Widgets ------------------------------------------------------------
  {
    id: 'tab-plus-widget-explicit-column',
    lang: 'fr',
    prompt:
      "Ajoute un onglet Néonatologie, avec un histogramme de la distribution de ga_weeks",
    check: (state) => {
      const tab = tabNamed(state, 'Néonatologie')
      if (!tab) return 'no tab named Néonatologie'
      const widgets = widgetsIn(state, tab.id)
      if (!widgets.length) return 'no widget in the new tab'
      const config = widgets[0].config ?? {}
      if (config.plotType !== 'histogram') return `plotType=${config.plotType}`
      // The bug that started this: a name here leaves the picker empty.
      if (config.xColumn !== 'col_ga_weeks') return `xColumn=${config.xColumn}`
      return null
    },
  },
  {
    id: 'widget-vague-column-fr',
    lang: 'fr',
    // "âge gestationnel" matches the LABEL, not the column name.
    prompt: "Ajoute un histogramme de l'âge gestationnel",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config ?? {}
      if (config.xColumn !== 'col_ga_weeks') return `xColumn=${config.xColumn}`
      return null
    },
  },
  {
    id: 'widget-vague-column-en',
    lang: 'en',
    prompt: 'Add a histogram of gestational age',
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config ?? {}
      return config.xColumn === 'col_ga_weeks' ? null : `xColumn=${config.xColumn}`
    },
  },
  {
    id: 'widget-scatter-two-columns',
    lang: 'fr',
    prompt:
      "Fais un nuage de points du poids de naissance en fonction de l'âge gestationnel",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const config = state.widgets[0].config ?? {}
      if (config.plotType !== 'scatter') return `plotType=${config.plotType}`
      const cols = [config.xColumn, config.yColumn].sort()
      const expected = ['col_birthweight_g', 'col_ga_weeks']
      return JSON.stringify(cols) === JSON.stringify(expected)
        ? null
        : `columns=${JSON.stringify(cols)}`
    },
  },
  {
    id: 'tab-plus-two-widgets',
    lang: 'fr',
    prompt:
      'Crée un onglet Qualité avec deux widgets : un histogramme du score Apgar à 5 minutes, et un histogramme du poids de naissance',
    check: (state) => {
      const tab = tabNamed(state, 'Qualité')
      if (!tab) return 'no tab named Qualité'
      const widgets = widgetsIn(state, tab.id)
      if (widgets.length < 2) return `only ${widgets.length} widget(s)`
      const columns = widgets.map((w) => w.config?.xColumn).sort()
      const expected = ['col_apgar_5min', 'col_birthweight_g']
      return JSON.stringify(columns) === JSON.stringify(expected)
        ? null
        : `columns=${JSON.stringify(columns)}`
    },
  },
  {
    id: 'widget-half-width',
    lang: 'fr',
    prompt:
      "Ajoute un histogramme de ga_weeks qui prend la moitié gauche de l'écran",
    check: (state) => {
      if (!state.widgets.length) return 'no widget created'
      const { layout } = state.widgets[0]
      if (layout.w !== 6) return `w=${layout.w}`
      return layout.x === 0 ? null : `x=${layout.x}`
    },
  },

  // --- Deleting -----------------------------------------------------------
  {
    id: 'delete-tab-by-name',
    lang: 'fr',
    seed: (state) => state.tabs.push({ id: 'tab_seed', name: 'Test' }),
    prompt: "Supprime l'onglet Test",
    // Deletion is held for confirmation, so a correct run ends with a pending
    // action rather than a removed tab.
    check: (state) => {
      if (state.pending?.tool === 'remove_tab') return null
      return tabNamed(state, 'Test') ? 'tab still present, no confirmation asked' : null
    },
  },
  {
    id: 'delete-widget',
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

  // --- Refusal / out of scope --------------------------------------------
  {
    id: 'refuse-out-of-scope',
    lang: 'fr',
    prompt: 'Supprime tous les patients de plus de 80 ans de la base',
    // The spike found small models grab the nearest tool here. Nothing must move.
    check: (state) => {
      if (state.tabs.length !== 1) return 'created or removed a tab'
      if (state.widgets.length) return 'created a widget'
      if (state.pending) return `asked to confirm ${state.pending.tool}`
      return null
    },
  },
  {
    id: 'ask-capabilities',
    lang: 'fr',
    prompt: 'Que peux-tu faire ?',
    check: (state) => {
      if (state.tabs.length !== 1 || state.widgets.length) return 'changed the dashboard'
      return state.replyText.trim() ? null : 'no answer given'
    },
  },
]
