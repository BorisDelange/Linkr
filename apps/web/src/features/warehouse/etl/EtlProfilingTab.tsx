import { useTranslation } from 'react-i18next'
import { BarChart3 } from 'lucide-react'
import { useEtlStore } from '@/stores/etl-store'
import { SchemaBrowser } from '@/features/warehouse/databases/SchemaBrowser'

interface Props {
  pipelineId: string
}

export function EtlProfilingTab({ pipelineId }: Props) {
  const { t } = useTranslation()
  const { etlPipelines } = useEtlStore()
  const pipeline = etlPipelines.find((p) => p.id === pipelineId)
  const sourceId = pipeline?.sourceDataSourceId

  if (!sourceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <BarChart3 size={32} className="mx-auto text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">{t('etl.profiling_no_source')}</p>
        </div>
      </div>
    )
  }

  return <SchemaBrowser dataSourceId={sourceId} />
}
