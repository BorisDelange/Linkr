import en from '@/locales/en.json'
import fr from '@/locales/fr.json'

/**
 * The languages a published catalog page can be written in. The app previews
 * the page in its own language; the export picks one.
 */
export type PageLocale = 'en' | 'fr'

export const PAGE_LOCALES: readonly PageLocale[] = ['en', 'fr']

export const pageLocaleOf = (language: string | undefined): PageLocale => (language?.startsWith('fr') ? 'fr' : 'en')

// Widened on purpose: handing the JSON's literal type (thousands of keys) to a
// lookup made every overload check compare against it — minutes of tsc time.
const BUNDLES: Record<PageLocale, unknown> = { en, fr }

/** A string of the app's translations in the page's language: DCAT labels, vocabulary names. */
export function bundleText(locale: PageLocale, key: string): string | undefined {
  let leaf: unknown = BUNDLES[locale]
  for (const k of key.split('.')) leaf = (leaf as Record<string, unknown> | undefined)?.[k]
  return typeof leaf === 'string' ? leaf : undefined
}

/** The explorer engine's texts (`data_catalog.xp`), placeholders in the engine's `{name}` form. */
export function exploreText(locale: PageLocale): Record<string, string> {
  const xp = (BUNDLES[locale] as { data_catalog: { xp: Record<string, string> } }).data_catalog.xp
  return Object.fromEntries(Object.entries(xp).map(([k, v]) => [k, v.replace(/\{\{(\w+)\}\}/g, '{$1}')]))
}

/**
 * The page's own texts. `{name}` placeholders are filled by `fill` (page
 * builder) or the page script's `lx` — plain replacement, no plural rules.
 */
const EN = {
  concept_catalog: 'Concept catalog',
  tab_explore: 'Explore',
  tab_metadata: 'Metadata',
  tab_schema: 'Schema',
  tab_info: 'Info',
  side_aria: 'Display and filters',
  metadata_title: 'Metadata',
  jsonld_view: 'View the raw JSON-LD source',
  jsonld_source: 'JSON-LD source',
  copy: 'Copy',
  copied: 'Copied',
  download: 'Download',
  close: 'Close',
  no_metadata: 'No Health-DCAT-AP metadata has been filled in for this catalog.',
  yes: 'Yes',
  no: 'No',
  class_catalog: 'Catalog',
  class_dataset: 'Dataset',
  class_distribution: 'Distribution',
  class_agent: 'Contacts and organisations',
  schema_title: 'Data schema',
  schema_tables_n: '{n} tables',
  schema_default_sub: 'Source warehouse structure',
  schema_tab_tables: 'Tables',
  schema_tab_diagram: 'Diagram',
  mapped_tables: 'Mapped tables',
  legend_patient: 'Patients',
  legend_visit: 'Visits',
  legend_concept: 'Concept dictionaries',
  legend_event: 'Event tables',
  role_pk: 'Primary key',
  role_fk: 'Foreign key',
  role_value: 'Value',
  role_date: 'Date',
  click_table: 'Click a table to see all its columns',
  no_schema: 'No schema available.',
  filter_tables: 'Filter tables…',
  col_one: 'col',
  col_other: 'cols',
  generated_on: 'Generated on {date}',
  generated_with: 'Generated with',
  ehds: 'EHDS Regulation (EU) 2025/327',
  concept_note_suppress: 'Concepts with fewer than {t} patients are not listed',
  concept_note_replace: 'Counts below {t} patients are shown as &lt; {t}',
  col_concept_id: 'Concept ID',
  col_concept_name: 'Concept name',
  col_vocabulary: 'Vocabulary',
  col_category: 'Category',
  col_subcategory: 'Subcategory',
  col_patients: 'Patients',
  col_visits: 'Hospitalizations',
  col_records: 'Records',
  // Page script
  group_1: 'One variable',
  group_2: 'Two variables',
  group_3: 'Three variables',
  variables: 'Variables',
  variables_aria: 'Variables to show',
  count: 'Count',
  filters: 'Filters',
  reset_filters: 'Reset filters',
  all: 'All',
  n_selected: '{n} selected',
  none: 'None',
  filter_ph: 'Filter…',
  keep_one_hint: 'Keep one value to read the others for it alone.',
  slider: 'Slider',
  calendar: 'Calendar',
  first_period: 'First period',
  last_period: 'Last period',
  from: 'From',
  to: 'To',
  cal_hint: 'Whole periods containing these dates are kept.',
  last_n: 'Last {n}',
  search_concepts: 'Search concepts…',
  all_categories: 'All categories',
  pin_title: 'One value at a time',
  pin_hint: 'Charts draw two variables; this one is read value by value.',
  pin_hint_all: 'Charts draw two variables; this one is read value by value, or all together.',
  charts: 'Charts',
  table: 'Table',
  download_csv: 'Download as CSV',
  below_threshold: 'Below the anonymisation threshold',
  search: 'Search…',
  no_match: 'No match',
  more_matches: '{n} more: refine the search',
  clear_filters: 'Clear filters',
  csv_title: 'Download the filtered rows as CSV',
  filter_col: 'Filter {c}',
  min_ph: '≥ min',
  drag_resize: 'Drag to resize, double-click to reset',
  rows_per_page: 'Rows per page',
  prev_page: 'Previous page',
  next_page: 'Next page',
  no_rows: 'No row matches these filters.',
  n_of_total: '{n} of {total}',
  row: 'row',
  rows: 'rows',
  nothing_computed: 'Nothing was computed for this catalog.',
}

export type PageText = typeof EN

const FR: PageText = {
  concept_catalog: 'Catalogue de concepts',
  tab_explore: 'Explorer',
  tab_metadata: 'Métadonnées',
  tab_schema: 'Schéma',
  tab_info: 'Infos',
  side_aria: 'Affichage et filtres',
  metadata_title: 'Métadonnées',
  jsonld_view: 'Voir la source JSON-LD brute',
  jsonld_source: 'Source JSON-LD',
  copy: 'Copier',
  copied: 'Copié',
  download: 'Télécharger',
  close: 'Fermer',
  no_metadata: "Aucune métadonnée Health-DCAT-AP n'a été renseignée pour ce catalogue.",
  yes: 'Oui',
  no: 'Non',
  class_catalog: 'Catalogue',
  class_dataset: 'Jeu de données',
  class_distribution: 'Distribution',
  class_agent: 'Contacts et organisations',
  schema_title: 'Schéma des données',
  schema_tables_n: '{n} tables',
  schema_default_sub: "Structure de l'entrepôt source",
  schema_tab_tables: 'Tables',
  schema_tab_diagram: 'Diagramme',
  mapped_tables: 'Tables mappées',
  legend_patient: 'Patients',
  legend_visit: 'Visites',
  legend_concept: 'Dictionnaires de concepts',
  legend_event: "Tables d'événements",
  role_pk: 'Clé primaire',
  role_fk: 'Clé étrangère',
  role_value: 'Valeur',
  role_date: 'Date',
  click_table: 'Cliquez sur une table pour voir toutes ses colonnes',
  no_schema: 'Aucun schéma disponible.',
  filter_tables: 'Filtrer les tables…',
  col_one: 'col.',
  col_other: 'col.',
  generated_on: 'Généré le {date}',
  generated_with: 'Généré avec',
  ehds: 'Règlement EHDS (UE) 2025/327',
  concept_note_suppress: 'Les concepts de moins de {t} patients ne sont pas listés',
  concept_note_replace: 'Les effectifs inférieurs à {t} patients sont affichés &lt; {t}',
  col_concept_id: 'ID du concept',
  col_concept_name: 'Nom du concept',
  col_vocabulary: 'Terminologie',
  col_category: 'Catégorie',
  col_subcategory: 'Sous-catégorie',
  col_patients: 'Patients',
  col_visits: 'Hospitalisations',
  col_records: 'Enregistrements',
  group_1: 'Une variable',
  group_2: 'Deux variables',
  group_3: 'Trois variables',
  variables: 'Variables',
  variables_aria: 'Variables à afficher',
  count: 'Comptage',
  filters: 'Filtres',
  reset_filters: 'Réinitialiser les filtres',
  all: 'Tout',
  n_selected: '{n} sélectionnés',
  none: 'Aucun',
  filter_ph: 'Filtrer…',
  keep_one_hint: 'Gardez une seule valeur pour lire les autres pour elle seule.',
  slider: 'Curseur',
  calendar: 'Calendrier',
  first_period: 'Première période',
  last_period: 'Dernière période',
  from: 'Du',
  to: 'Au',
  cal_hint: 'Les périodes entières contenant ces dates sont conservées.',
  last_n: '{n} derniers',
  search_concepts: 'Rechercher des concepts…',
  all_categories: 'Toutes les catégories',
  pin_title: 'Une valeur à la fois',
  pin_hint: 'Les graphiques montrent deux variables ; celle-ci se lit valeur par valeur.',
  pin_hint_all: 'Les graphiques montrent deux variables ; celle-ci se lit valeur par valeur, ou toutes ensemble.',
  charts: 'Graphiques',
  table: 'Tableau',
  download_csv: 'Télécharger en CSV',
  below_threshold: "Sous le seuil d'anonymisation",
  search: 'Rechercher…',
  no_match: 'Aucun résultat',
  more_matches: '{n} de plus : affinez la recherche',
  clear_filters: 'Effacer les filtres',
  csv_title: 'Télécharger les lignes filtrées en CSV',
  filter_col: 'Filtrer {c}',
  min_ph: '≥ min',
  drag_resize: 'Glisser pour redimensionner, double-clic pour réinitialiser',
  rows_per_page: 'Lignes par page',
  prev_page: 'Page précédente',
  next_page: 'Page suivante',
  no_rows: 'Aucune ligne ne correspond à ces filtres.',
  n_of_total: '{n} sur {total}',
  row: 'ligne',
  rows: 'lignes',
  nothing_computed: "Rien n'a été calculé pour ce catalogue.",
}

export const PAGE_TEXT: Record<PageLocale, PageText> = { en: EN, fr: FR }

/** Fill `{name}` placeholders. */
export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}
