/**
 * Lab plugins as a model reads them: the manifests on disk, documented from
 * their configSchema — never hand-written, so the doc cannot drift from the form.
 *
 * Two levels: `pluginSummary` (one line, enough to CHOOSE) and `pluginDoc` (the
 * fields of one plugin, enough to FILL). Cosmetic fields (colours, font sizes)
 * are dropped: they waste context and invite fiddling instead of answering.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PluginConfigField, PluginManifest } from '@/types/plugin'

const ANALYSES_DIR = fileURLToPath(new URL('../../../default-plugins/analyses/', import.meta.url))

let cache: PluginManifest[] | null = null

/** The analysis plugins whose manifest is a plugin.json on disk. */
export function listPlugins(): PluginManifest[] {
  if (cache) return cache
  cache = readdirSync(ANALYSES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${ANALYSES_DIR}${d.name}/plugin.json`))
    .map((d) => JSON.parse(readFileSync(`${ANALYSES_DIR}${d.name}/plugin.json`, 'utf8')) as PluginManifest)
  return cache
}

/** A plugin by id, accepting the short form ("plot-builder" for linkr-analysis-plot-builder). */
export function findPlugin(id: string): PluginManifest | undefined {
  const all = listPlugins()
  return all.find((p) => p.id === id) ?? all.find((p) => p.id === `linkr-analysis-${id}`)
}

/** Field types that only affect looks — never needed to satisfy a user request. */
const COSMETIC_TYPES = new Set(['icon-select', 'color-select', 'palette-editor'])

/** Cosmetic fields that slip through the type check (plain numbers/booleans). */
const COSMETIC_KEYS = new Set([
  'centerTitle', 'decimals', 'legendPosition', 'legendFontSize',
  'xAxisStartZero', 'yAxisStartZero', 'showGrid', 'showLegend',
  'opacity', 'pointSize', 'barSize', 'xLabelMaxLen', 'yLabelMaxLen',
  'colorPalette',
])

function isCosmetic(key: string, field: PluginConfigField): boolean {
  return COSMETIC_TYPES.has(field.type) || COSMETIC_KEYS.has(key)
}

/** English label/description text, falling back to the key itself. */
function en(value: { en: string; fr: string } | undefined): string | undefined {
  return value?.en?.trim() || undefined
}

/**
 * One line per plugin: id, name, what it does. This is what lets the model pick
 * a plugin without loading any schema (~25 tokens each).
 */
export function pluginSummary(manifest: PluginManifest): string {
  const name = en(manifest.name) ?? manifest.id
  const description = en(manifest.description) ?? ''
  return `- ${manifest.id} — ${name}: ${description}`
}

/**
 * Per-field documentation for ONE plugin: type, whether it is required, allowed
 * values, and the column kind it expects. Cosmetic fields are dropped.
 *
 * `hintWhen` is mined deliberately: it is where the manifest records that
 * `xColumn` is "required" for a scatter but unused for a histogram — a
 * conditional requirement the flat `optional` flag cannot express.
 */
export function pluginDoc(manifest: PluginManifest): string {
  const lines: string[] = []
  const name = en(manifest.name) ?? manifest.id
  lines.push(`${manifest.id} — ${name}`)
  const description = en(manifest.description)
  if (description) lines.push(description)
  lines.push('', 'Config fields:')

  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (isCosmetic(key, field)) continue

    const parts: string[] = []
    if (field.type === 'column-select') {
      parts.push(field.multi ? 'columns' : 'column')
      // The form uses this to restrict the picker; the model needs it to avoid
      // proposing a text column where a numeric one is required.
      if (field.filter) parts.push(`${field.filter} only`)
    } else {
      parts.push(field.type)
    }

    if (field.optional) parts.push('optional')
    if (field.default !== undefined && field.default !== '') {
      parts.push(`default ${JSON.stringify(field.default)}`)
    }
    if (field.options?.length) {
      parts.push(`one of: ${field.options.map((o) => o.value).join('|')}`)
    }
    if (typeof field.min === 'number' || typeof field.max === 'number') {
      parts.push(`range ${field.min ?? '-'}..${field.max ?? '-'}`)
    }

    let line = `  ${key} (${parts.join(', ')})`
    const help = en(field.description)
    if (help) line += ` — ${help}`

    // Conditional requirements, e.g. "scatter: required, histogram: unused".
    if (field.hintWhen) {
      const conditions = Object.entries(field.hintWhen.values)
        .map(([value, hint]) => `${value}: ${en(hint) ?? ''}`.trim())
        .filter((s) => !s.endsWith(':'))
      if (conditions.length) {
        line += ` [by ${field.hintWhen.field} → ${conditions.join('; ')}]`
      }
    }
    lines.push(line)
  }
  return lines.join('\n')
}
