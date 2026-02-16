import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDatasetStore } from '@/stores/dataset-store'
import { Table1Analysis } from './analyses/Table1Analysis'
import { DistributionAnalysis } from './analyses/DistributionAnalysis'
import { SummaryAnalysis } from './analyses/SummaryAnalysis'
import { CorrelationAnalysis } from './analyses/CorrelationAnalysis'
import { CrossTabAnalysis } from './analyses/CrossTabAnalysis'
import { CreateAnalysisDialog } from './CreateAnalysisDialog'
import type { DatasetAnalysis } from '@/types'

interface AnalysesPanelProps {
  datasetFileId: string
  hideTabBar?: boolean
}

function AnalysisContent({ analysis }: { analysis: DatasetAnalysis }) {
  switch (analysis.type) {
    case 'table1':
      return <Table1Analysis analysis={analysis} />
    case 'distribution':
      return <DistributionAnalysis analysis={analysis} />
    case 'summary':
      return <SummaryAnalysis analysis={analysis} />
    case 'correlation':
      return <CorrelationAnalysis analysis={analysis} />
    case 'crosstab':
      return <CrossTabAnalysis analysis={analysis} />
    default:
      return (
        <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
          Unknown analysis type: {analysis.type}
        </div>
      )
  }
}

export function AnalysesPanel({ datasetFileId, hideTabBar }: AnalysesPanelProps) {
  const { t } = useTranslation()
  const {
    analyses,
    selectedAnalysisId,
  } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)

  const activeAnalysis = analyses.find((a) => a.id === selectedAnalysisId)

  if (analyses.length === 0 && !activeAnalysis) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">{t('datasets.no_analyses')}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} className="mr-1" />
          {t('datasets.new_analysis')}
        </Button>
        <CreateAnalysisDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          datasetFileId={datasetFileId}
        />
      </div>
    )
  }

  // When hideTabBar is true, only render the content (tabs are in the parent)
  if (hideTabBar) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {activeAnalysis ? (
            <AnalysisContent analysis={activeAnalysis} />
          ) : (
            <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
              {t('datasets.select_analysis')}
            </div>
          )}
        </div>
        <CreateAnalysisDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          datasetFileId={datasetFileId}
        />
      </div>
    )
  }

  // Fallback: render with internal tab bar (not used in current layout)
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {activeAnalysis ? (
          <AnalysisContent analysis={activeAnalysis} />
        ) : (
          <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
            {t('datasets.select_analysis')}
          </div>
        )}
      </div>
      <CreateAnalysisDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        datasetFileId={datasetFileId}
      />
    </div>
  )
}
