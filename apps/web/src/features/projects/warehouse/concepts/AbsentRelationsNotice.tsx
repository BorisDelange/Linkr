import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SchemaMapping } from '@/types/schema-mapping'
import { NoticeBanner } from '@/components/ui/notice-banner'
import { sourceTables } from '@/lib/duckdb/engine'
import { absentRelations } from '@/lib/schema-classes/presence'

// Closed until the page reloads, per database and set of missing tables.
const dismissed = new Set<string>()

/**
 * Says that counts and patient data read some relations as empty, or without a
 * join, because the database lacks their table — which otherwise only shows as
 * missing rows.
 */
export function AbsentRelationsNotice({
  dataSourceId,
  mapping,
  className,
}: {
  dataSourceId: string | undefined
  mapping: SchemaMapping | undefined | null
  className?: string
}) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<{ id: string; names: string[] } | null>(null)
  const [, setClosed] = useState(0)

  useEffect(() => {
    if (!dataSourceId) return
    let live = true
    void sourceTables(dataSourceId).then((names) => {
      if (live && names) setTables({ id: dataSourceId, names })
    })
    return () => { live = false }
  }, [dataSourceId])

  const names = tables && tables.id === dataSourceId ? tables.names : null
  const absent = useMemo(() => (names && mapping ? absentRelations(mapping, names) : []), [names, mapping])
  const key = JSON.stringify([dataSourceId, ...absent.map((a) => [a.specKey, ...a.tables])])
  if (absent.length === 0 || dismissed.has(key)) return null

  return (
    <NoticeBanner
      tone="warning"
      title={t('schema_mapping.absent_tables_title', { count: absent.length })}
      description={t('concepts.absent_tables_description', {
        tables: [...new Set(absent.flatMap((a) => a.tables))].join(', '),
      })}
      onDismiss={() => {
        dismissed.add(key)
        setClosed((n) => n + 1)
      }}
      className={className}
    />
  )
}
