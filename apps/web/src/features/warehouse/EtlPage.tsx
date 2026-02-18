import { useParams } from 'react-router'
import { EtlListPage } from './etl/EtlListPage'
import { EtlPipelinePage } from './etl/EtlPipelinePage'

export function EtlPage() {
  const { pipelineId } = useParams()

  if (pipelineId) {
    return <EtlPipelinePage pipelineId={pipelineId} />
  }

  return <EtlListPage />
}
