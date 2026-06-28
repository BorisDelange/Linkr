import { useResolvedParams } from '@/hooks/use-resolved-params'
import { EtlListPage } from './etl/EtlListPage'
import { EtlPipelinePage } from './etl/EtlPipelinePage'

export function EtlPage() {
  const { raw } = useResolvedParams()
  const pipelineId = raw.pipelineId

  if (pipelineId) {
    return <EtlPipelinePage pipelineId={pipelineId} />
  }

  return <EtlListPage />
}
