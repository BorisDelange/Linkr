import type { ComponentType } from 'react'
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
}

const componentMap = new Map<string, ComponentType<ComponentPluginProps>>()
// Components that can compute their aggregate server-side (via datasetFileId +
// datasetFilters). Others are gated in server mode until migrated.
const serverCapable = new Set<string>()

export function registerComponent(
  id: string,
  component: ComponentType<ComponentPluginProps>,
  opts?: { supportsServer?: boolean },
) {
  componentMap.set(id, component)
  if (opts?.supportsServer) serverCapable.add(id)
}

export function getComponent(id: string): ComponentType<ComponentPluginProps> | undefined {
  return componentMap.get(id)
}

export function componentSupportsServer(id: string): boolean {
  return serverCapable.has(id)
}
