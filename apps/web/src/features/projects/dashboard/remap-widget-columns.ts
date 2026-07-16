import type { DashboardWidgetSource, DatasetColumn } from '@/types'
import { getPlugin } from '@/lib/plugins/registry'

/**
 * When a widget is reassigned to a different dataset, its config still references
 * the OLD dataset's column ids. Even though column ids are now deterministic slugs of
 * the name (so two datasets sharing a column name share its id), the two datasets
 * generally have DIFFERENT column names, so the old ids don't exist in the new dataset
 * and every column-select field would silently resolve to nothing. We bridge old → new
 * by matching on column NAME, the identifier a user reasons about.
 *
 * Returns a new source with column-select values remapped, or the original source
 * unchanged when there is nothing to remap (no plugin schema, no overlap, etc.).
 */
export function remapWidgetColumns(
  source: DashboardWidgetSource,
  oldColumns: DatasetColumn[],
  newColumns: DatasetColumn[],
): DashboardWidgetSource {
  // Only plugin widgets expose a config schema we can interpret. Inline widgets
  // hold free-form code; their config has no machine-readable column references.
  if (source.type !== 'plugin') return source
  const plugin = getPlugin(source.pluginId)
  const schema = plugin?.manifest.configSchema
  if (!schema) return source

  // Without the old dataset's columns we can't map ids back to names, so leave the
  // config untouched rather than blindly wiping every column reference.
  if (oldColumns.length === 0) return source

  const oldNameById = new Map(oldColumns.map((c) => [c.id, c.name]))
  const newIdByName = new Map(newColumns.map((c) => [c.name, c.id]))

  // old column id → new column id, keyed through the shared column name.
  const remapId = (oldId: string): string | null => {
    const name = oldNameById.get(oldId)
    if (name == null) return null
    return newIdByName.get(name) ?? null
  }

  let changed = false
  const config = { ...source.config }

  for (const [key, field] of Object.entries(schema)) {
    if (field.type !== 'column-select') continue
    const value = config[key]
    if (value == null) continue

    if (field.multi) {
      if (!Array.isArray(value)) continue
      // Drop references whose column name no longer exists in the new dataset.
      const remapped = (value as string[]).map(remapId).filter((id): id is string => id != null)
      config[key] = remapped
      changed = true
    } else {
      const remapped = remapId(value as string)
      // Clear a single-column reference that has no counterpart, rather than leave a dangling id.
      config[key] = remapped
      changed = true
    }
  }

  if (!changed) return source
  return { ...source, config }
}
