import type { DatasetAnalysis, BadgeColor } from '@/types'

/** A colored label badge on a plugin (same pattern as project badges). */
export interface PluginBadge {
  id: string
  label: string
  color: BadgeColor
}

/** Schema definition for a single config field in a plugin's configSchema. */
export interface PluginConfigField {
  type: 'column-select' | 'number' | 'select' | 'boolean' | 'string'
  label: { en: string; fr: string }
  multi?: boolean
  optional?: boolean
  filter?: 'numeric' | 'categorical'
  default?: unknown
  defaultAll?: boolean
  min?: number
  max?: number
  options?: { value: string; label: { en: string; fr: string } }[]
}

/** Runtime mode(s) the plugin supports. */
export type PluginRuntime = 'script' | 'js-widget'

/** The full plugin manifest, matching the JSON schema from plugin.json files. */
export interface AnalysisPluginManifest {
  id: string
  name: { en: string; fr: string; [key: string]: string }
  description: { en: string; fr: string; [key: string]: string }
  version: string
  category?: string
  tags: string[]
  runtime: PluginRuntime[]
  languages: ('python' | 'r')[]
  icon: string
  /** Color for the plugin icon (preset name or hex string). Defaults to muted-foreground. */
  iconColor?: BadgeColor
  configSchema: Record<string, PluginConfigField>
  /** Package dependencies per language, auto-installed on first run. */
  dependencies?: {
    python?: string[]
    r?: string[]
  }
  templates?: Record<string, string>
  component?: string
  /** Custom colored badges for categorizing the plugin. */
  badges?: PluginBadge[]
}

/** Resolved plugin with loaded templates and component reference. */
export interface AnalysisPlugin {
  manifest: AnalysisPluginManifest
  /** Loaded template strings, keyed by language. null if runtime is js-widget only. */
  templates: Record<string, string> | null
  /** React component for js-widget mode. null if runtime is script only. */
  jsComponent: React.ComponentType<{ analysis: DatasetAnalysis }> | null
}
