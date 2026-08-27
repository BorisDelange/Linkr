/**
 * Human-readable categorisation + description for the files shown in the git
 * sync panel. Versioning exports a folder tree whose filenames mean nothing to a
 * non-developer; this maps each known path to a category (for grouping) and an
 * i18n description key (shown in a hover tooltip), per git scope.
 *
 * A scope's rules are matched top-to-bottom; the first matching RegExp wins, so
 * put specific patterns before broad ones. Anything unmatched falls to "other".
 * Category keys + descriptions are i18n keys under `versioning.file_*`.
 */
import type { GitScope } from '@/lib/api/git'
import { README_FILE_RE } from '@/lib/entity-tree'

export interface GitFileMeta {
  /** Category key (stable id; label is `versioning.file_cat_<key>`). */
  category: string
  /** Sort order of the category within the list (lower = first). */
  order: number
  /** i18n key for the hover description (`versioning.file_desc_<...>`), or
   *  undefined when the file is unrecognised — the UI then shows no info icon
   *  rather than a generic, contentless tooltip. */
  descriptionKey?: string
}

interface Rule {
  test: RegExp
  category: string
  order: number
  descriptionKey: string
}

// Shared categories reused across scopes keep their order stable so mixed lists
// read consistently. "general" first, "other" last.
const CAT = {
  general: 0,
  readme: 1,
  scripts: 2,
  datasets: 3,
  dashboards: 4,
  cohorts: 5,
  pipeline: 6,
  environments: 7,
  databases: 8,
  mappings: 9,
  concepts: 10,
  scores: 11,
  checks: 12,
  config: 13,
  // Workspace-level entity groups (one box per entity kind in the workspace's
  // Details list — see the 'workspaces' rules below).
  projects: 20,
  mapping_projects: 21,
  wiki: 22,
  sql: 23,
  etl: 24,
  data_quality: 25,
  catalogs: 26,
  plugins: 27,
  concept_ids: 28,
  schemas: 29,
  // Settings scope (account-level) entity groups.
  organizations: 30,
  users: 31,
  roles: 32,
  attrs: 90,
  other: 99,
} as const

/** Every category a file row can carry. Its label is `versioning.file_cat_<key>`,
 *  interpolated at render time — exported so a test can assert each one has a
 *  translation (a dynamic key is invisible to a grep for literal key names). */
export const GIT_FILE_CATEGORIES = Object.keys(CAT) as (keyof typeof CAT)[]

const ATTRS_RULE: Rule = {
  test: /^\.gitattributes$/,
  category: 'attrs',
  order: CAT.attrs,
  descriptionKey: 'versioning.file_desc_gitattributes',
}

// The .gitignore is part of every exported tree (it excludes the re-derivable
// scores parquet), so it's a recognised, versioned file — not an "other" stray.
const GITIGNORE_RULE: Rule = {
  test: /^\.gitignore$/,
  category: 'config',
  order: CAT.config,
  descriptionKey: 'versioning.file_desc_gitignore',
}

const README_RULE: Rule = {
  test: README_FILE_RE,
  category: 'readme',
  order: CAT.readme,
  descriptionKey: 'versioning.file_desc_readme',
}

const LICENSE_RULE: Rule = {
  test: /^LICENSE\.md$/i,
  category: 'readme',
  order: CAT.readme,
  descriptionKey: 'versioning.file_desc_license',
}

const ATTACHMENTS_RULE: Rule = {
  test: /^attachments\//,
  category: 'readme',
  order: CAT.readme,
  descriptionKey: 'versioning.file_desc_readme_attachment',
}

const RULES: Partial<Record<GitScope, Rule[]>> = {
  projects: [
    { test: /^(entity|project)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_project_json' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    { test: /^tasks\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tasks' },
    { test: /^scripts\/_tree\.json$/, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_scripts_tree' },
    { test: /^scripts\//, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_script_file' },
    { test: /^datasets\/_tree\.json$/, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_datasets_tree' },
    { test: /^datasets\/.*\/_columns\.json$/, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_dataset_columns' },
    { test: /^datasets\//, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_dataset_file' },
    { test: /^dashboards\//, category: 'dashboards', order: CAT.dashboards, descriptionKey: 'versioning.file_desc_dashboard' },
    { test: /^cohorts\//, category: 'cohorts', order: CAT.cohorts, descriptionKey: 'versioning.file_desc_cohort' },
    { test: /^concept-lists\//, category: 'concepts', order: CAT.concepts, descriptionKey: 'versioning.file_desc_concept_list' },
    { test: /^pipeline\//, category: 'pipeline', order: CAT.pipeline, descriptionKey: 'versioning.file_desc_pipeline' },
    { test: /^environments\//, category: 'environments', order: CAT.environments, descriptionKey: 'versioning.file_desc_environment' },
    { test: /^databases\//, category: 'databases', order: CAT.databases, descriptionKey: 'versioning.file_desc_db_connection' },
    GITIGNORE_RULE,
    ATTRS_RULE,
  ],
  'mapping-projects': [
    { test: /^(entity|project)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_mp_project_json' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    { test: /^mappings\.(json|csv)$/, category: 'mappings', order: CAT.mappings, descriptionKey: 'versioning.file_desc_mappings' },
    { test: /source-concepts\.csv$/, category: 'concepts', order: CAT.concepts, descriptionKey: 'versioning.file_desc_source_concepts' },
    { test: /^source-concept-ids\//, category: 'concepts', order: CAT.concepts, descriptionKey: 'versioning.file_desc_source_concept_ids' },
    { test: /similarity-scores\.parquet$/, category: 'scores', order: CAT.scores, descriptionKey: 'versioning.file_desc_similarity_scores' },
    GITIGNORE_RULE,
    ATTRS_RULE,
  ],
  'sql-script-collections': [
    { test: /^(entity|_collection)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_collection_json' },
    { test: /^(scripts\/)?_tree\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tree' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    { test: /\.sql$/i, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_sql_file' },
    ATTRS_RULE,
  ],
  'etl-pipelines': [
    { test: /^(entity|_pipeline)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_pipeline_json' },
    { test: /^(scripts\/)?_tree\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tree' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    // mapping/*.csv before the generic script rules: these are a mapping project's
    // own dictionary (gitignored by default), not pipeline code, and the user
    // decides per file whether they are versioned at all.
    { test: /^mapping\/.*\.csv$/i, category: 'mappings', order: CAT.mappings, descriptionKey: 'versioning.file_desc_etl_mapping_csv' },
    { test: /\.(sql|py|r)$/i, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_etl_script_file' },
    GITIGNORE_RULE,
    ATTRS_RULE,
  ],
  'data-catalogs': [
    { test: /^(entity|catalog)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_catalog_json' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    ATTRS_RULE,
  ],
  'dq-rule-sets': [
    { test: /^(entity\.json|rule-set\.json)$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_ruleset_json' },
    { test: /^checks\.json$/, category: 'checks', order: CAT.checks, descriptionKey: 'versioning.file_desc_dq_checks' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    ATTRS_RULE,
  ],
  'schema-presets': [
    { test: /^(entity|preset)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_preset_json' },
    // The mapping moved out of the manifest into its own file. Without a rule it
    // fell to 'other', i.e. a foreign file Linkr does not own — so it showed up
    // unclassified and its deletion was never offered.
    { test: /^mapping\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_preset_mapping' },
    { test: /^schema\.ddl$/, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_schema_ddl' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    ATTRS_RULE,
  ],
  settings: [
    { test: /^organizations\.json$/, category: 'organizations', order: CAT.organizations, descriptionKey: 'versioning.file_desc_settings_organizations' },
    { test: /^users\.json$/, category: 'users', order: CAT.users, descriptionKey: 'versioning.file_desc_settings_users' },
    { test: /^roles\.json$/, category: 'roles', order: CAT.roles, descriptionKey: 'versioning.file_desc_settings_roles' },
    ATTRS_RULE,
  ],
  'user-plugins': [
    { test: /^(entity|_plugin)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_plugin_meta' },
    { test: /^plugin\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_plugin_manifest' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    { test: /\.(js|ts|jsx|tsx|py|r|css)$/i, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_plugin_source' },
    ATTRS_RULE,
  ],
  // Workspace export: one box per top-level entity kind (matched most-specific
  // first). The workspace root holds a few general files; everything else lives
  // under a folder prefix. source-concept-ids/ (badge allocation) is its own box.
  workspaces: [
    { test: /^(entity|workspace)\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_workspace_json' },
    README_RULE,
    LICENSE_RULE,
    ATTACHMENTS_RULE,
    { test: /^source-concept-ids\//, category: 'concept_ids', order: CAT.concept_ids, descriptionKey: 'versioning.file_desc_source_concept_ids' },
    { test: /^projects\//, category: 'projects', order: CAT.projects, descriptionKey: 'versioning.file_desc_ws_project' },
    { test: /^mapping-projects\//, category: 'mapping_projects', order: CAT.mapping_projects, descriptionKey: 'versioning.file_desc_ws_mapping_project' },
    { test: /^databases\//, category: 'databases', order: CAT.databases, descriptionKey: 'versioning.file_desc_db_connection' },
    { test: /^wiki\//, category: 'wiki', order: CAT.wiki, descriptionKey: 'versioning.file_desc_ws_wiki' },
    { test: /^sql-scripts\//, category: 'sql', order: CAT.sql, descriptionKey: 'versioning.file_desc_ws_sql' },
    { test: /^etl\//, category: 'etl', order: CAT.etl, descriptionKey: 'versioning.file_desc_ws_etl' },
    { test: /^data-quality\//, category: 'data_quality', order: CAT.data_quality, descriptionKey: 'versioning.file_desc_ws_dq' },
    { test: /^(catalogs|service-mappings)\//, category: 'catalogs', order: CAT.catalogs, descriptionKey: 'versioning.file_desc_ws_catalog' },
    { test: /^concept-sets\//, category: 'mappings', order: CAT.mappings, descriptionKey: 'versioning.file_desc_ws_concept_set' },
    { test: /^schemas\//, category: 'schemas', order: CAT.schemas, descriptionKey: 'versioning.file_desc_ws_schema' },
    { test: /^plugins\//, category: 'plugins', order: CAT.plugins, descriptionKey: 'versioning.file_desc_ws_plugin' },
    { test: /^git-links\.json$/, category: 'config', order: CAT.config, descriptionKey: 'versioning.file_desc_git_links' },
    { test: /^organization\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_ws_organization' },
    GITIGNORE_RULE,
    ATTRS_RULE,
  ],
}

// Unrecognised files: grouped under "other", with no description — the row then
// shows no info icon rather than a generic tooltip that says nothing useful.
const OTHER: GitFileMeta = { category: 'other', order: CAT.other }

/** Resolve a file's category + description for a scope (falls back to "other"). */
export function gitFileMeta(scope: GitScope, path: string): GitFileMeta {
  for (const rule of RULES[scope] ?? []) {
    if (rule.test.test(path)) {
      return { category: rule.category, order: rule.order, descriptionKey: rule.descriptionKey }
    }
  }
  return OTHER
}

export interface GitFileGroup<T> {
  category: string
  order: number
  files: T[]
}

/** Group files by category (using each file's path) and sort groups by order,
 *  keeping the original file order within each group. */
export function groupGitFiles<T>(scope: GitScope, files: T[], pathOf: (f: T) => string): GitFileGroup<T>[] {
  const byCat = new Map<string, GitFileGroup<T>>()
  for (const f of files) {
    const meta = gitFileMeta(scope, pathOf(f))
    let group = byCat.get(meta.category)
    if (!group) {
      group = { category: meta.category, order: meta.order, files: [] }
      byCat.set(meta.category, group)
    }
    group.files.push(f)
  }
  return [...byCat.values()].sort((a, b) => a.order - b.order)
}
