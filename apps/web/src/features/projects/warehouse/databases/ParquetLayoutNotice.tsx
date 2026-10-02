import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SchemaMapping } from '@/types/schema-mapping'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { getParquetLayout } from '@/lib/api/data-sources'
import { patientLayoutChecks, unsortedTables, type LayoutEntry } from '@/lib/duckdb/parquet-layout'

/** Read once per database and session: the files do not change under a page. */
const layouts = new Map<string, Promise<LayoutEntry[]>>()

/**
 * Warns when the database's Parquet tables are not stored in patient order:
 * every patient view then reads each table in full, where sorted files let
 * DuckDB skip all but a few row groups. Server mode, Parquet folders only.
 */
export function ParquetLayoutNotice({ dataSourceId, schemaMapping }: { dataSourceId: string; schemaMapping: SchemaMapping }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<{ id: string; tables: LayoutEntry[] } | null>(null)

  useEffect(() => {
    const checks = patientLayoutChecks(schemaMapping)
    if (checks.length === 0) return
    const key = `${dataSourceId}\u0001${JSON.stringify(checks)}`
    let hit = layouts.get(key)
    if (!hit) {
      hit = getParquetLayout(dataSourceId, checks).catch(() => {
        layouts.delete(key)
        return []
      })
      layouts.set(key, hit)
    }
    let cancelled = false
    void hit.then((all) => { if (!cancelled) setEntries({ id: dataSourceId, tables: unsortedTables(all) }) })
    return () => { cancelled = true }
  }, [dataSourceId, schemaMapping])

  const tables = entries?.id === dataSourceId ? entries.tables : []
  if (tables.length === 0) return null
  const list = tables
    .map((e) => `${e.table} (${Math.round((e.scanFraction ?? 0) * 100)} %)`)
    .join(', ')
  return (
    <NoticeBanner
      tone="warning"
      title={t('databases.layout_unsorted_title', { count: tables.length })}
      description={t('databases.layout_unsorted_description', { tables: list })}
    />
  )
}
