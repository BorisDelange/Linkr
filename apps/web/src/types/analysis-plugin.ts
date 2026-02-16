import type { DatasetAnalysis } from '@/types'

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
  configSchema: Record<string, PluginConfigField>
  templates?: Record<string, string>
  component?: string
}

/** Resolved plugin with loaded templates and component reference. */
export interface AnalysisPlugin {
  manifest: AnalysisPluginManifest
  /** Loaded template strings, keyed by language. null if runtime is js-widget only. */
  templates: Record<string, string> | null
  /** React component for js-widget mode. null if runtime is script only. */
  jsComponent: React.ComponentType<{ analysis: DatasetAnalysis }> | null
}
