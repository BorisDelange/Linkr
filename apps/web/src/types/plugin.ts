import type { BadgeColor, OrganizationInfo, CatalogVisibility, PluginOrigin, ParentRef, ChangelogEntry } from '@/types'

/** A colored label badge on a plugin (same pattern as project badges). */
export interface PluginBadge {
  id: string
  label: string
  color: BadgeColor
}

/** Schema definition for a single config field in a plugin's configSchema. */
export interface PluginConfigField {
  type: 'column-select' | 'column-value-select' | 'number' | 'select' | 'boolean' | 'string' | 'icon-select' | 'color-select'
  label: { en: string; fr: string }
  multi?: boolean
  optional?: boolean
  filter?: 'numeric' | 'categorical'
  /** For `column-value-select`: the config key of the column-select field to read values from. */
  columnField?: string
  default?: unknown
  defaultAll?: boolean
  min?: number
  max?: number
  options?: { value: string; label: { en: string; fr: string }; onlyForColumnType?: 'numeric' | 'categorical' }[]
  /** For `select`: filter options based on the type of the column selected in this field. */
  filterOptionsByColumn?: string
  /** Fields sharing the same row value are rendered side-by-side. */
  row?: string
  /** Only show this field when another field has a specific value, or when it is not empty. */
  visibleWhen?: { field: string; value?: unknown; notEmpty?: boolean }
  /** Tooltip description shown as an info icon next to the label. */
  description?: { en: string; fr: string }
  /** Static hint badge shown next to the label (e.g. "required", "optional"). */
  hint?: { en: string; fr: string }
  /** Conditional hint: shown only when another field has a specific value. Overrides `hint`. */
  hintWhen?: { field: string; values: Record<string, { en: string; fr: string }> }
  /**
   * Auto-set other fields when a column-select changes, based on column type.
   * Only applies to `column-select` fields.
   * Example: `{ numeric: { aggregate: 'mean' }, categorical: { aggregate: 'proportion' } }`
   */
  autoSet?: {
    numeric?: Record<string, unknown>
    categorical?: Record<string, unknown>
  }
}

/** Runtime mode(s) the plugin supports. */
export type PluginRuntime = 'script' | 'component'

/** Where the plugin can be used: lab (datasets/dashboards) or warehouse (patient data). */
export type PluginScope = 'lab' | 'warehouse'

/** The full plugin manifest, matching the JSON schema from plugin.json files. */
export interface PluginManifest {
  id: string
  name: { en: string; fr: string; [key: string]: string }
  description: { en: string; fr: string; [key: string]: string }
  version: string
  /** Where the plugin is used: 'lab' (datasets/dashboards) or 'warehouse' (patient data). Defaults to 'lab'. */
  scope?: PluginScope
  category?: string
  tags: string[]
  runtime: PluginRuntime[]
  languages: ('python' | 'r')[]
  icon: string
  /** Color for the plugin icon (preset name or hex string). Defaults to muted-foreground. */
  iconColor?: BadgeColor
  configSchema: Record<string, PluginConfigField>
  /** If true, the plugin uses ConceptPickerDialog for concept selection (warehouse plugins). */
  needsConceptPicker?: boolean
  /** Package dependencies per language, auto-installed on first run. */
  dependencies?: {
    python?: string[]
    r?: string[]
  }
  templates?: Record<string, string>
  /** Custom colored badges for categorizing the plugin. */
  badges?: PluginBadge[]
  /** Organization or author metadata. */
  organization?: OrganizationInfo
  /** Whether this plugin appears in the community catalog. Defaults to 'unlisted'. */
  catalogVisibility?: CatalogVisibility
  /** SHA-256 hash of functional content (configSchema, templates, dependencies, runtime, languages). */
  contentHash?: string
  /** Original creator of this plugin (before any forks). */
  origin?: PluginOrigin
  /** Parent version this was forked from. */
  parentRef?: ParentRef
  /** Human-written release notes per version. */
  changelog?: ChangelogEntry[]
}

/** Resolved plugin with loaded templates. */
export interface Plugin {
  manifest: PluginManifest
  /** Loaded template strings, keyed by language. */
  templates: Record<string, string> | null
  /** For component-runtime plugins: ID mapping to a registered React component. */
  componentId?: string
  /** Workspace this plugin belongs to (undefined for built-in plugins). */
  workspaceId?: string
}
