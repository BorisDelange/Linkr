import { queryDataSource } from './engine'
import { buildCatalogAggregationQuery } from './catalog-queries'
import { getStorage } from '@/lib/storage'
import type { DataCatalog, CatalogResultCache, CatalogResultRow, CatalogMarginRow, CatalogConceptTotal, CatalogGrandTotal, CatalogMargins, ServiceMapping } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'

/**
 * Compute a catalog: build GROUPING SETS SQL, execute against DuckDB,
 * classify rows into leaf/margin/total buckets, cache result.
 */
export async function computeCatalog(
  catalog: DataCatalog,
  dataSourceId: string,
  mapping: SchemaMapping,
  serviceMappings: ServiceMapping[],
): Promise<CatalogResultCache> {
  const startTime = performance.now()

  // Resolve service mapping rules if care_site dimension references one
  const careSiteDim = catalog.dimensions.find((d) => d.type === 'care_site' && d.enabled)
  const smId = careSiteDim?.careSite?.serviceMappingId
  const smRules = smId
    ? serviceMappings.find((m) => m.id === smId)?.rules
    : undefined

  // Build SQL with GROUPING SETS
  const result = buildCatalogAggregationQuery(
    mapping,
    catalog.dimensions,
    smRules,
    catalog.categoryColumn,
    catalog.subcategoryColumn,
  )
  if (!result) {
    throw new Error('Cannot build catalog query: missing schema mapping (patient table, visit table, or concept dictionaries)')
  }

  // Execute
  const rawRows = await queryDataSource(dataSourceId, result.sql)

  // Classify rows by GROUPING() bitmask flags
  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimKeys = enabledDims.map((d) => `dim_${d.type}`)

  const leafRows: CatalogResultRow[] = []
  const conceptTotals: CatalogConceptTotal[] = []
  const dimOnlyMargins: Record<string, CatalogMarginRow[]> = {}
  let grandTotal: CatalogGrandTotal = { totalPatients: 0, totalVisits: 0, totalRecords: 0 }

  // Initialize margin buckets
  for (const dim of enabledDims) {
    dimOnlyMargins[dim.id] = []
  }

  for (const row of rawRows) {
    const flags = Number(row.grp_flags ?? 0)
    const conceptRolledUp = (flags & result.conceptBitMask) !== 0

    // Count how many dims are NOT rolled up (bit = 0 means grouped)
    const activeDimIds: string[] = []
    for (let i = 0; i < enabledDims.length; i++) {
      const alias = dimKeys[i]
      const bitPos = result.dimBitPositions[alias]
      if (bitPos !== undefined) {
        const bitVal = (flags >> bitPos) & 1
        if (bitVal === 0) activeDimIds.push(enabledDims[i].id)
      }
    }

    const pCount = Number(row.patient_count ?? 0)
    const rCount = Number(row.record_count ?? 0)
    const vCount = Number(row.visit_count ?? 0)

    if (conceptRolledUp && activeDimIds.length === 0) {
      // Grand total: all columns rolled up
      grandTotal = { totalPatients: pCount, totalVisits: vCount, totalRecords: rCount }
    } else if (conceptRolledUp && activeDimIds.length === 1) {
      // Dimension-only margin: concept rolled up, one dim active
      const dimId = activeDimIds[0]
      const dim = enabledDims.find((d) => d.id === dimId)!
      const alias = `dim_${dim.type}`
      dimOnlyMargins[dimId].push({
        value: row[alias] as string | number,
        patientCount: pCount,
        recordCount: rCount,
        visitCount: vCount,
      })
    } else if (!conceptRolledUp && activeDimIds.length === enabledDims.length) {
      // Leaf row: concept × all dims active
      const dimensions: Record<string, string | number | null> = {}
      for (let i = 0; i < enabledDims.length; i++) {
        const dimId = enabledDims[i].id
        const dimKey = dimKeys[i]
        dimensions[dimId] = row[dimKey] != null ? (row[dimKey] as string | number) : null
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
    } else if (!conceptRolledUp && activeDimIds.length === 0) {
      // Concept total: all dims rolled up, concept active
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
    // Other intermediate grouping sets (concept + 2..N-1 dims) are skipped
  }

  const durationMs = Math.round(performance.now() - startTime)
  const uniqueConcepts = new Set(leafRows.map((r) => r.conceptId))

  // When no dimensions are enabled, leaf rows ARE concept totals (same grouping set)
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

  // Persist to IDB
  await getStorage().catalogResults.save(cache)

  return cache
}
