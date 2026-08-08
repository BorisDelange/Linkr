import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Table2 } from 'lucide-react'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'
import { PipelineDbPicker } from './PipelineDbPicker'
import { useRoleSchemas } from './use-role-schemas'

interface Props {
  pipelineId: string
  /** Database to show on arrival — set when the scripts tab sends the user here. */
  initialDataSourceId?: string
}

export function EtlSchemasTab({ pipelineId, initialDataSourceId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const { roleOf, dataSourceIdOf } = useRoleSchemas(pipeline)

  // The pipeline's own databases: its two roles plus the ATHENA reference of its
  // mapping project. Unrelated workspace databases are not addressable here.
  const databases = useMemo(() => (
    [...new Set([
      pipeline?.sourceDataSourceId,
      pipeline?.targetDataSourceId,
      dataSourceIdOf('vocab'),
    ].filter(Boolean) as string[])]
      .map((id) => dataSources.find((ds) => ds.id === id))
      .filter((ds): ds is NonNullable<typeof ds> => !!ds)
  ), [pipeline?.sourceDataSourceId, pipeline?.targetDataSourceId, dataSourceIdOf, dataSources])

  // Only the user's explicit pick is state; the rest is derived, so no effect
  // has to sync it and a pick that disappears (role reassigned, source deleted)
  // simply stops matching and lets the fallback take over. The pick is tagged
  // with the request it was made against, so arriving from "Browse schema" on
  // another database wins over a stale pick instead of being ignored.
  const [picked, setPicked] = useState<{ id: string; forRequest?: string } | null>(null)
  const pickIsCurrent = picked?.forRequest === initialDataSourceId
  const candidates = [
    pickIsCurrent ? picked?.id : undefined,
    initialDataSourceId,
    pipeline?.sourceDataSourceId,
  ]
  const selectedId = candidates.find((id) => id && databases.some((ds) => ds.id === id))
    ?? databases[0]?.id

  if (!selectedId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Table2 size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.profiling_no_source')}</p>
        </div>
      </div>
    )
  }

  const role = roleOf(selectedId)

  return (
    <SchemaBrowser
      key={selectedId}
      dataSourceId={selectedId}
      tableQualifier={role ? `${role}.` : undefined}
      toolbarExtra={
        <PipelineDbPicker
          databases={databases}
          selectedId={selectedId}
          onSelect={(id) => setPicked({ id, forRequest: initialDataSourceId })}
          roleOf={roleOf}
        />
      }
    />
  )
}
