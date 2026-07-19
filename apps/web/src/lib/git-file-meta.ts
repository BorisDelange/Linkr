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
  databases: 7,
  mappings: 8,
  concepts: 9,
  scores: 10,
  checks: 11,
  config: 12,
  attrs: 90,
  other: 99,
} as const

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
  test: /^README(\.[a-z]{2})?\.md$/i,
  category: 'readme',
  order: CAT.readme,
  descriptionKey: 'versioning.file_desc_readme',
}

const RULES: Partial<Record<GitScope, Rule[]>> = {
  projects: [
    { test: /^project\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_project_json' },
    README_RULE,
    { test: /^tasks\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tasks' },
    { test: /^scripts\/_tree\.json$/, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_scripts_tree' },
    { test: /^scripts\//, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_script_file' },
    { test: /^datasets\/_tree\.json$/, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_datasets_tree' },
    { test: /^datasets\/.*\/_columns\.json$/, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_dataset_columns' },
    { test: /^datasets\//, category: 'datasets', order: CAT.datasets, descriptionKey: 'versioning.file_desc_dataset_file' },
    { test: /^dashboards\//, category: 'dashboards', order: CAT.dashboards, descriptionKey: 'versioning.file_desc_dashboard' },
    { test: /^cohorts\//, category: 'cohorts', order: CAT.cohorts, descriptionKey: 'versioning.file_desc_cohort' },
    { test: /^pipeline\//, category: 'pipeline', order: CAT.pipeline, descriptionKey: 'versioning.file_desc_pipeline' },
    { test: /^databases\//, category: 'databases', order: CAT.databases, descriptionKey: 'versioning.file_desc_db_connection' },
    ATTRS_RULE,
  ],
  'mapping-projects': [
    { test: /^project\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_mp_project_json' },
    README_RULE,
    { test: /^mappings\.(json|csv)$/, category: 'mappings', order: CAT.mappings, descriptionKey: 'versioning.file_desc_mappings' },
    { test: /source-concepts\.csv$/, category: 'concepts', order: CAT.concepts, descriptionKey: 'versioning.file_desc_source_concepts' },
    { test: /^source-concept-ids\//, category: 'concepts', order: CAT.concepts, descriptionKey: 'versioning.file_desc_source_concept_ids' },
    { test: /similarity-scores\.parquet$/, category: 'scores', order: CAT.scores, descriptionKey: 'versioning.file_desc_similarity_scores' },
    GITIGNORE_RULE,
    ATTRS_RULE,
  ],
  'sql-script-collections': [
    { test: /^_collection\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_collection_json' },
    { test: /^_tree\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tree' },
    { test: /\.sql$/i, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_sql_file' },
    ATTRS_RULE,
  ],
  'etl-pipelines': [
    { test: /^_pipeline\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_pipeline_json' },
    { test: /^_tree\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_tree' },
    ATTRS_RULE,
  ],
  'data-catalogs': [
    { test: /^catalog\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_catalog_json' },
    ATTRS_RULE,
  ],
  'dq-rule-sets': [
    { test: /^rule-set\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_ruleset_json' },
    { test: /^checks\.json$/, category: 'checks', order: CAT.checks, descriptionKey: 'versioning.file_desc_dq_checks' },
    ATTRS_RULE,
  ],
  'schema-presets': [
    { test: /^preset\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_preset_json' },
    ATTRS_RULE,
  ],
  'user-plugins': [
    { test: /^_plugin\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_plugin_meta' },
    { test: /^plugin\.json$/, category: 'general', order: CAT.general, descriptionKey: 'versioning.file_desc_plugin_manifest' },
    README_RULE,
    { test: /\.(js|ts|jsx|tsx|py|r|css)$/i, category: 'scripts', order: CAT.scripts, descriptionKey: 'versioning.file_desc_plugin_source' },
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
