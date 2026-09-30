import type { CustomSchemaPreset, DataSource } from '@/types'

/**
 * A custom preset's key in the add-database dialog's schema dropdown.
 *
 * `id ?? presetId`, the same key SchemaPresetsPage uses — `presetId` stopped
 * being the key when presets gained a separate identity (see
 * docs/design/schema-preset-identity-plan.md). The option value and the lookup
 * that reads it back must agree, or a preset installed from the catalog (where
 * id, entityId and presetId all differ) selects but resolves to no mapping.
 */
export function presetKey(p: CustomSchemaPreset): string {
  return p.id ?? p.presetId
}

/**
 * The installed preset an existing database's schema came from, or undefined.
 *
 * Lineage first: it is the only identity that survives crossing instances. A
 * database imported with its workspace carries the ORIGIN instance's `presetId`
 * in its copied mapping, which matches nothing here — the field then read empty
 * for a database that is in fact mapped, and there was no way to re-link it.
 * `presetId` is still tried after, as the local key of a database built here.
 */
export function findSourcePreset(
  source: Pick<DataSource, 'schemaSource' | 'schemaMapping'>,
  presets: CustomSchemaPreset[],
): CustomSchemaPreset | undefined {
  const lineageId = source.schemaSource?.lineageId
  const byLineage = lineageId ? presets.find((p) => p.lineageId === lineageId) : undefined
  if (byLineage) return byLineage
  const storedPresetId = source.schemaMapping?.presetId
  if (!storedPresetId || storedPresetId === 'none') return undefined
  return presets.find((p) => p.presetId === storedPresetId || presetKey(p) === storedPresetId)
}
