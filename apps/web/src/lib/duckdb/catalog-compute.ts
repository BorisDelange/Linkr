import { queryDataSource } from './engine'
import { buildCatalogAggregationQuery } from './catalog-queries'
import { getStorage } from '@/lib/storage'
import type { DataCatalog, CatalogResultCache, CatalogResultRow, ServiceMapping } from '@/types'
import type { SchemaMapping } from '@/types/schema-mapping'

/**
 * Compute a catalog: build SQL, execute against DuckDB, transform rows, cache result.
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

  // Build SQL
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
  const rows = await queryDataSource(dataSourceId, result.sql)

  // Transform to CatalogResultRow[]
  const enabledDims = catalog.dimensions.filter((d) => d.enabled)
  const dimKeys = enabledDims.map((d) => `dim_${d.type}`)

  const catalogRows: CatalogResultRow[] = rows.map((row) => {
    const dimensions: Record<string, string | number | null> = {}
    for (let i = 0; i < enabledDims.length; i++) {
      const dimId = enabledDims[i].id
      const dimKey = dimKeys[i]
      dimensions[dimId] = row[dimKey] != null ? (row[dimKey] as string | number) : null
    }

    return {
      conceptId: row.concept_id as number | string,
      conceptName: row.concept_name as string,
      dictionaryKey: row.dictionary_key as string | undefined,
      category: catalog.categoryColumn ? (row.concept_category as string | null) ?? null : undefined,
      subcategory: catalog.subcategoryColumn ? (row.concept_subcategory as string | null) ?? null : undefined,
      patientCount: Number(row.patient_count ?? 0),
      recordCount: Number(row.record_count ?? 0),
      dimensions,
    }
  })

  const durationMs = Math.round(performance.now() - startTime)

  // Compute totals
  const uniqueConcepts = new Set(catalogRows.map((r) => r.conceptId))
  const uniquePatients = new Set<number | string>()
  // Total patients is an approximation — the best we can do without a separate query
  // We use the max patient_count across all rows for the same concept as a rough total
  const conceptPatientMax = new Map<number | string, number>()
  for (const row of catalogRows) {
    const prev = conceptPatientMax.get(row.conceptId) ?? 0
    if (row.patientCount > prev) conceptPatientMax.set(row.conceptId, row.patientCount)
  }
  let totalPatients = 0
  for (const count of conceptPatientMax.values()) totalPatients += count

  const cache: CatalogResultCache = {
    catalogId: catalog.id,
    computedAt: new Date().toISOString(),
    durationMs,
    rows: catalogRows,
    totalConcepts: uniqueConcepts.size,
    totalPatients,
  }

  // Persist to IDB
  await getStorage().catalogResults.save(cache)

  return cache
}
