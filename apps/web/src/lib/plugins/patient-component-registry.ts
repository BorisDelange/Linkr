import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'

/**
 * Props every patient-data component plugin receives.
 *
 * Deliberately NOT an extension of `ComponentPluginProps`: a Lab plugin reads a
 * dataset's `columns`/`rows`, a patient widget reads OMOP tables for the selected
 * patient. Merging the two would leave every Lab plugin carrying OMOP fields it
 * never reads and every patient widget carrying dataset fields that are always
 * empty. What the two models DO share — the manifest format, the file layout,
 * `configSchema` + GenericConfigPanel, versioning, lazy loading — is shared.
 */
export interface PatientComponentPluginProps {
  config: Record<string, unknown>
  /** Widget id, for components that keep their own per-widget state. */
  widgetId: string
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  personId: string | null
  visitOccurrenceId: string | null
  visitDetailId: string | null
  /** Open the widget's concept picker, when its manifest declares one. */
  onConfigureConcepts?: () => void
}

type PatientComponentLoader = () => Promise<{
  default: ComponentType<PatientComponentPluginProps>
}>

const loaderMap = new Map<string, PatientComponentLoader>()
const lazyCache = new Map<
  string,
  LazyExoticComponent<ComponentType<PatientComponentPluginProps>>
>()

/**
 * Register a built-in patient widget by a lazy loader rather than the component
 * itself, so heavy libs (dygraphs…) stay out of the initial bundle. Mirrors
 * `component-registry.ts` for the Lab scope.
 */
export function registerPatientComponent(id: string, loader: PatientComponentLoader) {
  loaderMap.set(id, loader)
}

/** React.lazy component for this id (memoized), or undefined if none.
 *  Callers must render it inside a <Suspense> boundary. */
export function getPatientComponent(
  id: string,
): LazyExoticComponent<ComponentType<PatientComponentPluginProps>> | undefined {
  const cached = lazyCache.get(id)
  if (cached) return cached
  const loader = loaderMap.get(id)
  if (!loader) return undefined
  const lazyComp = lazy(loader)
  lazyCache.set(id, lazyComp)
  return lazyComp
}
