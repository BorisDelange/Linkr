import type { GitFileChange, GitScope } from '@/lib/api/git'
import { isDefaultSelected, isForeignPath } from '@/lib/git-file-classify'

/** One changed file an action will commit, with its git change type (A/M/D) so the
 *  UI can badge it — a "deleted" row makes clear the action REMOVES that file. */
export interface QuickActionFile {
  path: string
  changeType: string
}

/**
 * A one-click commit+push preset for the versioning panel: a curated subset of
 * the currently-changed files, committed together with an auto-generated
 * message — so a non-developer needn't hand-tick files for the common cases.
 *
 * `files` is already narrowed to the files that ACTUALLY changed (the intersection
 * of the preset's patterns with the current change set), so the UI can list the
 * exact paths + change badges and disable the action when nothing relevant changed.
 */
export interface QuickAction {
  /** i18n key for the action title (e.g. versioning.quick_sync_all). */
  labelKey: string
  /** i18n key for the short description shown on the action card. */
  descriptionKey: string
  /** i18n key for the commit message, interpolated with { author }. */
  messageKey: string
  /** The changed files this action will commit + push, in list order. */
  files: QuickActionFile[]
  /** The primary "sync everything" preset — carries the shared accent color. */
  isSyncAll: boolean
}

interface QuickActionDef {
  labelKey: string
  descriptionKey: string
  messageKey: string
  /** When present, only paths matching one of these are included; when absent,
   *  ALL changed paths are included ("sync everything that changed"). */
  patterns?: RegExp[]
  /** Drop foreign files Linkr doesn't manage (a stray/unknown file another tool
   *  wrote — see isForeignPath), plus everything the Details commit list leaves
   *  unchecked by default (isDefaultSelected: a modified hand-enrichable
   *  .gitignore/.gitattributes, config/foreign deletions). Used by "Sync all" so
   *  a one-click commit versions everything Linkr owns without sweeping in what
   *  the user should push deliberately from Details. Also marks the preset as
   *  the "Sync all" one for the shared accent. */
  excludeForeign?: boolean
  /** Extra paths this preset never commits, applied after every other rule.
   *  For deletions Linkr's export can't distinguish from "the app simply doesn't
   *  write this" — see the databases scope. */
  exclude?: RegExp[]
}

// Per-scope presets, in display order (first is the primary/"all" action).
const DEFS: Partial<Record<GitScope, QuickActionDef[]>> = {
  // ONE card, deliberately (matches lib/pull-quick-actions.ts).
  //
  // A per-kind card commits a SUBSET, and this scope's files are not independent:
  // `stats` in project.json is derived from mappings.json, so "Sync mappings"
  // pushed rows whose counters stayed behind in a project.json it did not touch —
  // a repo contradicting itself. Anyone wanting a genuine subset has the Details
  // tab, where the choice is explicit and the whole file list is in view.
  'mapping-projects': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all',
      messageKey: 'versioning.quick_msg_all',
      excludeForeign: true,
    },
  ],
  projects: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_project',
      messageKey: 'versioning.quick_msg_all_project',
      excludeForeign: true,
    },
    {
      labelKey: 'versioning.quick_sync_dashboards',
      descriptionKey: 'versioning.quick_desc_dashboards',
      messageKey: 'versioning.quick_msg_dashboards',
      patterns: [/^dashboards\//],
    },
    {
      labelKey: 'versioning.quick_sync_scripts',
      descriptionKey: 'versioning.quick_desc_scripts',
      messageKey: 'versioning.quick_msg_scripts',
      patterns: [/^scripts\//],
    },
  ],
  'sql-script-collections': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_collection',
      messageKey: 'versioning.quick_msg_all_collection',
      excludeForeign: true,
    },
  ],
  workspaces: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_workspace',
      messageKey: 'versioning.quick_msg_all_workspace',
      excludeForeign: true,
    },
  ],
  // Single-entity scopes: their repo is small and homogeneous (a config JSON, or a
  // manifest + a few files), so a per-kind preset would just restate "Sync all".
  'etl-pipelines': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_pipeline',
      messageKey: 'versioning.quick_msg_all_pipeline',
      excludeForeign: true,
    },
  ],
  'data-catalogs': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_catalog',
      messageKey: 'versioning.quick_msg_all_catalog',
      excludeForeign: true,
    },
  ],
  'dq-rule-sets': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_rule_set',
      messageKey: 'versioning.quick_msg_all_rule_set',
      excludeForeign: true,
    },
  ],
  'schema-presets': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_schema_preset',
      messageKey: 'versioning.quick_msg_all_schema_preset',
      excludeForeign: true,
    },
  ],
  // "Sync all" here excludes `data/` deletions, unlike every other scope. A repo
  // authored outside Linkr ships its tables under data/, and the app publishes
  // metadata only — so those files are absent from every export and show up as
  // deletions in every push status, without the user having removed anything.
  // Sweeping them in would drop a repo's tables on a button labelled "sync";
  // dropping them stays possible, from Details, per file.
  databases: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_database',
      messageKey: 'versioning.quick_msg_all_database',
      excludeForeign: true,
      exclude: [/^data\//],
    },
  ],
  'user-plugins': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_plugin',
      messageKey: 'versioning.quick_msg_all_plugin',
      excludeForeign: true,
    },
  ],
  // "What to version" as one-click presets: all, or just one entity kind.
  settings: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_settings',
      messageKey: 'versioning.quick_msg_all_settings',
      excludeForeign: true,
    },
    {
      labelKey: 'versioning.quick_sync_settings_organizations',
      descriptionKey: 'versioning.quick_desc_settings_organizations',
      messageKey: 'versioning.quick_msg_settings_organizations',
      patterns: [/^organizations\.json$/],
    },
    {
      labelKey: 'versioning.quick_sync_settings_users',
      descriptionKey: 'versioning.quick_desc_settings_users',
      messageKey: 'versioning.quick_msg_settings_users',
      patterns: [/^users\.json$/],
    },
    {
      labelKey: 'versioning.quick_sync_settings_roles',
      descriptionKey: 'versioning.quick_desc_settings_roles',
      messageKey: 'versioning.quick_msg_settings_roles',
      patterns: [/^roles\.json$/],
    },
  ],
}

/** Resolve the scope's quick actions against the current changed files. Each
 *  action's `files` preserves the order of `changes`. Actions whose patterns
 *  match nothing still appear with an empty `files` (the UI disables them). */
export function buildQuickActions(
  scope: GitScope,
  changes: GitFileChange[],
): QuickAction[] {
  const defs = DEFS[scope]
  if (!defs) return []
  return defs.map((def) => {
    let files: QuickActionFile[] = (def.patterns
      ? changes.filter((c) => def.patterns!.some((re) => re.test(c.path)))
      : [...changes]
    ).map((c) => ({ path: c.path, changeType: c.changeType }))
    if (def.excludeForeign) {
      files = files.filter((f) => !isForeignPath(scope, f.path) && isDefaultSelected(scope, f))
    }
    if (def.exclude) {
      files = files.filter((f) => !def.exclude!.some((re) => re.test(f.path)))
    }
    return {
      labelKey: def.labelKey,
      descriptionKey: def.descriptionKey,
      messageKey: def.messageKey,
      files,
      isSyncAll: !!def.excludeForeign,
    }
  })
}
