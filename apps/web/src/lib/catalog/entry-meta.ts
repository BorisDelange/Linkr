/**
 * Icon, colors and label for each catalog entry type.
 *
 * Mirrors the icon block every entity's own list page draws, so a catalog card reads as
 * the same kind of object as the cards on the page it installs into. Values are copied
 * from those pages verbatim — `project` is the blue one, the six warehouse types are
 * teal, and `mapping-project` really is `text-teal-600` where its siblings are 500.
 *
 * Keep in sync with: ProjectsPage, MappingProjectListPage, SqlScriptsListPage,
 * EtlListPage, CatalogListPage (data catalogs), DqRuleSetListPage, SchemaPresetsPage.
 */

import {
  ArrowRightLeft,
  BookOpen,
  Database,
  FolderOpen,
  ShieldCheck,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { CatalogEntryType } from './types'

export interface EntryTypeMeta {
  icon: LucideIcon
  /** Icon tint, as used on the type's own list-page card. */
  color: string
  /** Tinted square behind the icon. */
  bg: string
  labelKey: string
}

export const ENTRY_TYPE_META: Record<CatalogEntryType, EntryTypeMeta> = {
  'project': {
    icon: FolderOpen,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-500/10',
    labelKey: 'catalog.type_project',
  },
  'mapping-project': {
    icon: ArrowRightLeft,
    color: 'text-teal-600',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_mapping_project',
  },
  'sql-collection': {
    icon: SquareTerminal,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_sql_collection',
  },
  'etl-pipeline': {
    icon: Workflow,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_etl_pipeline',
  },
  'data-catalog': {
    icon: BookOpen,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_data_catalog',
  },
  'dq-rule-set': {
    icon: ShieldCheck,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_dq_rule_set',
  },
  'schema-preset': {
    icon: Database,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    labelKey: 'catalog.type_schema_preset',
  },
}

/** Entry types, in the order they appear in the type filter. */
export const ENTRY_TYPES: CatalogEntryType[] = [
  'project',
  'mapping-project',
  'sql-collection',
  'etl-pipeline',
  'data-catalog',
  'dq-rule-set',
  'schema-preset',
]
