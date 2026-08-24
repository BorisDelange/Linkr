import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { DatasetColumn } from '@/types'

/** Props that every component-runtime plugin receives. */
export interface ComponentPluginProps {
  config: Record<string, unknown>
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  /** When true, the component should render in compact/full-bleed mode (e.g. inside a dashboard widget). */
  compact?: boolean
  /** Server-mode context: a component that supports server-side aggregation uses
   *  these (dataset reference + resolved filters) to compute on the backend instead
   *  of the in-memory `rows` (which are empty in server mode). Optional; components
   *  not yet migrated ignore them and are gated by the caller. */
  datasetFileId?: string | null
  datasetFilters?: unknown[]
  /**
   * Write back into the analysis config, for a control the RESULT itself owns.
   *
   * Most settings belong in the config panel. This is for a choice that only
   * makes sense next to the thing it applies to — picking the test for one row
   * of a results table, where a panel would need a control per variable.
   *
   * Absent in read-only surfaces (a dashboard widget), so a component must
   * treat its own controls as unavailable when it is not passed.
   */
  onConfigChange?: (changes: Record<string, unknown>) => void
}

type ComponentLoader = () => Promise<{ default: ComponentType<ComponentPluginProps> }>

const loaderMap = new Map<string, ComponentLoader>()
const lazyCache = new Map<string, LazyExoticComponent<ComponentType<ComponentPluginProps>>>()
// Components that can compute their aggregate server-side (via datasetFileId +
// datasetFilters). Others are gated in server mode until migrated.
const serverCapable = new Set<string>()

/**
 * Register a built-in viz component by a lazy loader rather than the component
 * itself, so heavy charting libs (recharts, leaflet, vis-network…) are NOT pulled
 * into the initial bundle at registerDefaultPlugins() time. The component's chunk
 * loads only when it first renders.
 */
export function registerComponent(
  id: string,
  loader: ComponentLoader,
  opts?: { supportsServer?: boolean },
) {
  loaderMap.set(id, loader)
  if (opts?.supportsServer) serverCapable.add(id)
}

/** Returns a React.lazy component for this id (memoized), or undefined if none.
 *  Callers must render it inside a <Suspense> boundary. */
export function getComponent(id: string): LazyExoticComponent<ComponentType<ComponentPluginProps>> | undefined {
  const cached = lazyCache.get(id)
  if (cached) return cached
  const loader = loaderMap.get(id)
  if (!loader) return undefined
  const lazyComp = lazy(loader)
  lazyCache.set(id, lazyComp)
  return lazyComp
}

export function componentSupportsServer(id: string): boolean {
  return serverCapable.has(id)
}
