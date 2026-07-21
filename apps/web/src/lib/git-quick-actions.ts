import type { GitFileChange, GitScope } from '@/lib/api/git'
import { gitFileMeta } from '@/lib/git-file-meta'

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
  /** The primary "sync everything" preset — carries the shared accent color and,
   *  when data files aren't included, the deletion warning. */
  isSyncAll: boolean
}

interface QuickActionDef {
  labelKey: string
  descriptionKey: string
  messageKey: string
  /** When present, only paths matching one of these are included; when absent,
   *  ALL changed paths are included ("sync everything that changed"). */
  patterns?: RegExp[]
  /** Drop paths whose git-file category is "other" (unrecognised files). Used by
   *  "Sync all" so a stray/unknown file isn't swept into a one-click commit —
   *  the user handles those deliberately from the Details tab. This also marks the
   *  preset as the "Sync all" one for the shared accent + data-deletion warning. */
  excludeOther?: boolean
}

// Per-scope presets, in display order (first is the primary/"all" action).
const DEFS: Partial<Record<GitScope, QuickActionDef[]>> = {
  'mapping-projects': [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all',
      messageKey: 'versioning.quick_msg_all',
      excludeOther: true,
    },
    {
      labelKey: 'versioning.quick_sync_mappings',
      descriptionKey: 'versioning.quick_desc_mappings',
      messageKey: 'versioning.quick_msg_mappings',
      patterns: [/^project\.json$/, /^mappings\.(json|csv)$/],
    },
  ],
  projects: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_project',
      messageKey: 'versioning.quick_msg_all_project',
      excludeOther: true,
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
  workspaces: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_workspace',
      messageKey: 'versioning.quick_msg_all_workspace',
      excludeOther: true,
    },
  ],
  // "What to version" as one-click presets: all, or just one entity kind.
  settings: [
    {
      labelKey: 'versioning.quick_sync_all',
      descriptionKey: 'versioning.quick_desc_all_settings',
      messageKey: 'versioning.quick_msg_all_settings',
      excludeOther: true,
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

/** Heavy dataset content files (gated by the "include data files" toggle). When the
 *  toggle is OFF these are gitignored and dropped from the export, so a "Sync all"
 *  against a remote that HAS them pushes their DELETION — the UI warns about that. */
const DATA_FILE_RE = /^datasets\/.*\.(csv|parquet|xlsx|xls)$|^datasets\/.*\/_data\.json$/
export function isDataFilePath(path: string): boolean {
  return DATA_FILE_RE.test(path)
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
    if (def.excludeOther) {
      files = files.filter((f) => gitFileMeta(scope, f.path).category !== 'other')
    }
    return {
      labelKey: def.labelKey,
      descriptionKey: def.descriptionKey,
      messageKey: def.messageKey,
      files,
      isSyncAll: !!def.excludeOther,
    }
  })
}
