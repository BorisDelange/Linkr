import type { CatalogVariableId } from '@/types/catalog'
import type { PublishedCatalog, PublishedVariable } from '@/lib/data-catalog/publish'

/** Types of catalog-explore.js, the explorer engine shared with the standalone page. */

export interface ExploreData extends PublishedCatalog {
  concepts: { cols: { key: string; label: string; type: 'text' | 'number'; filter?: string; width?: number; className?: string }[]; rows: unknown[][] }
  totals: { patients: number; stays: number; records: number; concepts?: number }
}

export interface ExploreState {
  crossing: string | null
  metric: 'patients' | 'stays' | 'records'
  sel: Partial<Record<CatalogVariableId, Record<number, true>>>
  range: [number, number] | null
  cq: string
  ccat: string
  pin: CatalogVariableId | null
  pinVal: number | null
  topN: number
  scale: 'row' | 'all'
  periodMode: 'slider' | 'calendar'
  tab: 'charts' | 'table'
}

export interface ExploreStat { key: string; label: string; value: string; sub: string; icon: string }
export interface ExploreBlock {
  title: string
  size: 'half' | 'full'
  sub?: string
  note?: string
  /** Trusted HTML of the block's own controls (data-act="topn" buttons). */
  head?: string
  render: (width: number) => string
  csv?: { name: string; text: () => string }
}
export interface ExploreTableColumn {
  key: string
  label: string
  type: 'text' | 'number'
  variable?: CatalogVariableId
  measure?: boolean
  filter?: string
  width?: number
  className?: string
}
export interface ExploreTable {
  kind: 'cells' | 'concepts'
  columns: ExploreTableColumn[]
  rows: Record<string, unknown>[]
  maskText?: Record<number, string>
  maskTip?: Record<number, string>
  initialSort: { key: string; desc: boolean } | null
  csvFileName: string
}
export interface ExploreView {
  title: string
  context: { v: CatalogVariableId; label: string; value: string }[]
  stats: ExploreStat[]
  blocks: ExploreBlock[]
  table: ExploreTable | null
  empty: string
}

export interface Explorer {
  S: ExploreState
  V: Partial<Record<CatalogVariableId, PublishedVariable>>
  options(): { size: number; items: { id: string; vars: CatalogVariableId[] }[] }[]
  varsOf(id: string | null): CatalogVariableId[]
  varLabel(v: CatalogVariableId): string
  plural(v: CatalogVariableId): string
  measures(): ('patients' | 'stays' | 'records')[]
  measureLabel(m: string): string
  isListView(): boolean
  canUnpin(): boolean
  setCrossing(id: string): void
  toggleSel(v: CatalogVariableId, i: number): void
  reset(): void
  conceptCategories(): string[]
  view(): ExploreView
  tr(key: string, vars?: Record<string, string | number>): string
}

export const EXPLORE_TEXT: Record<string, string>
export const VARIABLE_HEX: Record<CatalogVariableId, string>
export function createExplorer(
  data: ExploreData,
  opts?: { reveal?: boolean; text?: Record<string, string>; locale?: string; dark?: () => boolean; fileBase?: string; conceptNote?: string },
): Explorer
