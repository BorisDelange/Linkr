import type { GitScope } from '@/lib/api/git'
import { gitFileMeta } from '@/lib/git-file-meta'

/**
 * A one-click commit+push preset for the versioning panel: a curated subset of
 * the currently-changed files, committed together with an auto-generated
 * message — so a non-developer needn't hand-tick files for the common cases.
 *
 * `paths` is already narrowed to the files that ACTUALLY changed (the intersection
 * of the preset's patterns with the current change set), so the UI can list the
 * exact paths in a tooltip and disable the action when nothing relevant changed.
 */
export interface QuickAction {
  /** i18n key for the action title (e.g. versioning.quick_sync_all). */
  labelKey: string
  /** i18n key for the short description shown on the action card. */
  descriptionKey: string
  /** i18n key for the commit message, interpolated with { author }. */
  messageKey: string
  /** The changed paths this action will commit + push, in list order. */
  paths: string[]
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
   *  the user handles those deliberately from the Details tab. */
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

/** Resolve the scope's quick actions against the current changed paths. Each
 *  action's `paths` preserves the order of `changedPaths`. Actions whose patterns
 *  match nothing still appear with an empty `paths` (the UI disables them). */
export function buildQuickActions(
  scope: GitScope,
  changedPaths: string[],
): QuickAction[] {
  const defs = DEFS[scope]
  if (!defs) return []
  return defs.map((def) => {
    let paths = def.patterns
      ? changedPaths.filter((p) => def.patterns!.some((re) => re.test(p)))
      : [...changedPaths]
    if (def.excludeOther) {
      paths = paths.filter((p) => gitFileMeta(scope, p).category !== 'other')
    }
    return { labelKey: def.labelKey, descriptionKey: def.descriptionKey, messageKey: def.messageKey, paths }
  })
}
