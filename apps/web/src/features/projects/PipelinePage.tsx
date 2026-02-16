import { ReactFlowProvider } from '@xyflow/react'
import { PipelineCanvas } from './pipeline/PipelineCanvas'

export function PipelinePage() {
  return (
    <ReactFlowProvider>
      <PipelineCanvas />
    </ReactFlowProvider>
  )
}
