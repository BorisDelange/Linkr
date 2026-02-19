import { queryDataSource } from './engine'
import { buildPerDictionaryQueries } from './catalog-queries'
import type { DictionaryQueryParts } from './catalog-queries'
import { getStorage } from '@/lib/storage'
import type { DataCatalog, CatalogResultCache, CatalogResultRow, CatalogMarginRow, CatalogConceptTotal, CatalogGrandTotal, CatalogMargins, ServiceMapping } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'
import type { DimensionConfig } from '@/types/catalog'

export type ComputeStep = 'mounting' | 'building' | 'executing' | 'processing' | 'saving'

export interface ComputeProgress {
  step: ComputeStep
  /** 0–1 fraction within the current step (0 = just started, 1 = done). */
  fraction: number
  /** Human-readable label for the current sub-step (e.g. dictionary key). */
  detail?: string
}

/**
 * Compute a catalog by executing one query per concept dictionary,
 * then a global query for dim-only margins and grand total.
 * Reports progress via onProgress callback.
 */
export async function computeCatalog(
  catalog: DataCatalog,
  dataSourceId: string,
  mapping: SchemaMapping,
  serviceMappings: ServiceMapping[],
  onProgress?: (progress: ComputeProgress) => void,
): Promise<CatalogResultCache> {
  const startTime = performance.now()

  // Step 1: Building queries
  onProgress?.({ step: 'building', fraction: 0 })

  const careSiteDim = catalog.dimensions.find((d) => d.type === 'care_site' && d.enabled)
  const smId = careSiteDim?.careSite?.serviceMappingId
  const smRules = smId
    ? serviceMappings.find((m) => m.id === smId)?.rules
    : undefined

  const queries = buildPerDictionaryQueries(
    mapping,
    catalog.dimensions,
    smRules,
    catalog.categoryColumn,
    catalog.subcategoryColumn,
  )
  if (!queries) {
    throw new Error('Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)')
  }

  onProgress?.({ step: 'building', fraction: 1 })

  // Step 2: Execute queries with progress
  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimKeys = enabledDims.map((d) => `dim_${d.type}`)

  const leafRows: CatalogResultRow[] = []
  const conceptTotals: CatalogConceptTotal[] = []
  const dimOnlyMargins: Record<string, CatalogMarginRow[]> = {}
  let grandTotal: CatalogGrandTotal = { totalPatients: 0, totalVisits: 0, totalRecords: 0 }

  for (const dim of enabledDims) {
    dimOnlyMargins[dim.id] = []
  }

  // Total steps: dict queries + 1 global query
  const totalSteps = queries.dictQueries.length + 1
  let completedSteps = 0

  // 2a. Execute per-dictionary queries (leaf rows + concept totals)
  for (const dq of queries.dictQueries) {
    onProgress?.({
      step: 'executing',
      fraction: completedSteps / totalSteps,
      detail: dq.dictKey,
    })

    const rawRows = await queryDataSource(dataSourceId, dq.sql)
    classifyDictRows(rawRows, dq, enabledDims, dimKeys, catalog, leafRows, conceptTotals)

    completedSteps++
  }

  // 2b. Execute global query (dim-only margins + grand total)
  onProgress?.({
    step: 'executing',
    fraction: completedSteps / totalSteps,
    detail: 'totals',
  })

  const globalRows = await queryDataSource(dataSourceId, queries.globalQuery)
  for (const row of globalRows) {
    const pCount = Number(row.patient_count ?? 0)
    const rCount = Number(row.record_count ?? 0)
    const vCount = Number(row.visit_count ?? 0)

    // Check which dims have non-NULL values
    const activeDimIds: string[] = []
    for (let i = 0; i < enabledDims.length; i++) {
      if (row[dimKeys[i]] != null) activeDimIds.push(enabledDims[i].id)
    }

    if (activeDimIds.length === 0) {
      grandTotal = { totalPatients: pCount, totalVisits: vCount, totalRecords: rCount }
    } else if (activeDimIds.length === 1) {
      const dimId = activeDimIds[0]
      const dim = enabledDims.find((d) => d.id === dimId)!
      const alias = `dim_${dim.type}`
      dimOnlyMargins[dimId].push({
        value: row[alias] as string | number,
        patientCount: pCount,
        recordCount: rCount,
        visitCount: vCount,
      })
    }
  }

  completedSteps++
  onProgress?.({ step: 'executing', fraction: 1 })

  // Step 3: Build cache
  onProgress?.({ step: 'processing', fraction: 0 })

  const durationMs = Math.round(performance.now() - startTime)
  const uniqueConcepts = new Set(leafRows.map((r) => r.conceptId))
  const finalConceptTotals = enabledDims.length === 0 ? [] : conceptTotals

  const margins: CatalogMargins = {
    byDimension: dimOnlyMargins,
    conceptTotals: finalConceptTotals,
    grandTotal,
  }

  const cache: CatalogResultCache = {
    catalogId: catalog.id,
    computedAt: new Date().toISOString(),
    durationMs,
    rows: leafRows,
    totalConcepts: uniqueConcepts.size,
    totalPatients: grandTotal.totalPatients,
    totalVisits: grandTotal.totalVisits,
    margins,
  }

  onProgress?.({ step: 'processing', fraction: 1 })

  // Step 4: Saving to IDB
  onProgress?.({ step: 'saving', fraction: 0 })
  await getStorage().catalogResults.save(cache)
  onProgress?.({ step: 'saving', fraction: 1 })

  return cache
}

/**
 * Classify rows from a per-dictionary GROUPING SETS query into leaf/concept-total buckets.
 */
function classifyDictRows(
  rawRows: Record<string, unknown>[],
  dq: DictionaryQueryParts,
  enabledDims: DimensionConfig[],
  dimKeys: string[],
  catalog: DataCatalog,
  leafRows: CatalogResultRow[],
  conceptTotals: CatalogConceptTotal[],
): void {
  const { conceptBitMask, dimBitPositions } = dq.meta

  for (const row of rawRows) {
    const flags = Number(row.grp_flags ?? 0)
    const conceptRolledUp = (flags & conceptBitMask) !== 0
    if (conceptRolledUp) continue // per-dict queries shouldn't produce these, but skip just in case

    const activeDimIds: string[] = []
    for (let i = 0; i < enabledDims.length; i++) {
      const alias = dimKeys[i]
      const bitPos = dimBitPositions[alias]
      if (bitPos !== undefined) {
        const bitVal = (flags >> bitPos) & 1
        if (bitVal === 0) activeDimIds.push(enabledDims[i].id)
      }
    }

    const pCount = Number(row.patient_count ?? 0)
    const rCount = Number(row.record_count ?? 0)
    const vCount = Number(row.visit_count ?? 0)

    if (activeDimIds.length === enabledDims.length) {
      // Leaf row: concept × all dims (or concept-only when no dims)
      const dimensions: Record<string, string | number | null> = {}
      for (let i = 0; i < enabledDims.length; i++) {
        dimensions[enabledDims[i].id] = row[dimKeys[i]] != null ? (row[dimKeys[i]] as string | number) : null
      }

      leafRows.push({
        conceptId: row.concept_id as number | string,
        conceptName: row.concept_name as string,
        dictionaryKey: row.dictionary_key as string | undefined,
        category: catalog.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
        subcategory: catalog.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
        patientCount: pCount,
        recordCount: rCount,
        visitCount: vCount,
        dimensions,
      })
    } else if (activeDimIds.length === 0 && enabledDims.length > 0) {
      // Concept total: all dims rolled up
      conceptTotals.push({
        conceptId: row.concept_id as number | string,
        conceptName: row.concept_name as string,
        dictionaryKey: row.dictionary_key as string | undefined,
        category: catalog.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
        subcategory: catalog.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
        patientCount: pCount,
        recordCount: rCount,
        visitCount: vCount,
      })
    }
  }
}
