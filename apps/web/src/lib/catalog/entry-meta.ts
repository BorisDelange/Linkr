/**
 * Icon, colors and label for each catalog entry type.
 *
 * Mirrors the icon block every entity's own list page draws, so a catalog card reads as
 * the same kind of object as the cards on the page it installs into. The colours are not
 * restated here: they come from `@/lib/entity-colors`, the one place a kind's hue is
 * chosen, shared with the sidebar and the list pages.
 */

import {
  ArrowRightLeft,
  BookOpen,
  Database,
  FolderOpen,
  LayoutGrid,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { ENTITY_COLORS, type EntityColorKey } from '@/lib/entity-colors'
import type { CatalogEntryType } from './types'

export interface EntryTypeMeta {
  icon: LucideIcon
  /** Icon tint, as used on the type's own list-page card. */
  color: string
  /** Tinted square behind the icon. */
  bg: string
  /** Type badge on the catalog card, in the icon's own hue. */
  badge: string
  labelKey: string
}

/** Every catalog entry type is also an entity kind, so the hue lookup is direct. */
const ENTRY_ICONS: Record<CatalogEntryType, { icon: LucideIcon; labelKey: string }> = {
  'workspace': { icon: LayoutGrid, labelKey: 'catalog.type_workspace' },
  'project': { icon: FolderOpen, labelKey: 'catalog.type_project' },
  'mapping-project': { icon: ArrowRightLeft, labelKey: 'catalog.type_mapping_project' },
  'sql-collection': { icon: SquareTerminal, labelKey: 'catalog.type_sql_collection' },
  'etl-pipeline': { icon: Workflow, labelKey: 'catalog.type_etl_pipeline' },
  'data-catalog': { icon: BookOpen, labelKey: 'catalog.type_data_catalog' },
  'dq-rule-set': { icon: ShieldCheck, labelKey: 'catalog.type_dq_rule_set' },
  'schema-preset': { icon: Database, labelKey: 'catalog.type_schema_preset' },
  'database': { icon: Database, labelKey: 'catalog.type_database' },
}

export const ENTRY_TYPE_META = Object.fromEntries(
  Object.entries(ENTRY_ICONS).map(([type, { icon, labelKey }]) => {
    const color = ENTITY_COLORS[type as EntityColorKey]
    return [type, { icon, labelKey, color: color.icon, bg: color.bg, badge: color.badge }]
  }),
) as Record<CatalogEntryType, EntryTypeMeta>

// Re-exported for existing importers; the source of truth is types.ts (pure).
export { ENTRY_TYPES } from './types'
