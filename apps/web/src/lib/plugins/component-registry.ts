import type { ComponentType } from 'react'
import type { DatasetColumn } from '@/types'

/** Props that every component-runtime plugin receives. */
export interface ComponentPluginProps {
  config: Record<string, unknown>
  columns: DatasetColumn[]
  rows: Record<string, unknown>[]
  /** When true, the component should render in compact/full-bleed mode (e.g. inside a dashboard widget). */
  compact?: boolean
}

const componentMap = new Map<string, ComponentType<ComponentPluginProps>>()

export function registerComponent(id: string, component: ComponentType<ComponentPluginProps>) {
  componentMap.set(id, component)
}

export function getComponent(id: string): ComponentType<ComponentPluginProps> | undefined {
  return componentMap.get(id)
}
