/**
 * Plugin documentation for an LLM, derived from the manifest — never hand-written.
 *
 * A hand-written doc would drift from `configSchema` on the first change; this
 * derives from the same source the config form reads, so it cannot go stale.
 *
 * Two levels (progressive disclosure, like Agent Skills):
 *  - `pluginSummary` — one line per plugin, always in context. Enough to CHOOSE.
 *  - `pluginDoc` — the fields of one plugin, fetched on demand. Enough to FILL.
 *
 * The filtering matters as much as the extraction: plot-builder has 35 config
 * fields, of which ~20 are pure appearance (colors, font sizes, opacity). Feeding
 * all of them wastes context and invites the model to fiddle with cosmetics
 * instead of answering the question.
 */
import type { PluginConfigField, PluginManifest } from '@/types/plugin'

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
