import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { Table1Analysis } from './analyses/Table1Analysis'
import { DistributionAnalysis } from './analyses/DistributionAnalysis'
import { CreateAnalysisDialog } from './CreateAnalysisDialog'
import type { DatasetAnalysis } from '@/types'

interface AnalysesPanelProps {
  datasetFileId: string
}

function AnalysisContent({ analysis }: { analysis: DatasetAnalysis }) {
  switch (analysis.type) {
    case 'table1':
      return <Table1Analysis analysis={analysis} />
    case 'distribution':
      return <DistributionAnalysis analysis={analysis} />
    default:
      return (
        <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
          Unknown analysis type: {analysis.type}
        </div>
      )
  }
}

export function AnalysesPanel({ datasetFileId }: AnalysesPanelProps) {
  const { t } = useTranslation()
  const {
    analyses,
    openAnalysisIds,
    selectedAnalysisId,
    selectAnalysis,
    closeAnalysis,
    isAnalysisDirty,
    _dirtyVersion,
  } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const openAnalyses = openAnalysisIds
    .map((id) => analyses.find((a) => a.id === id))
    .filter((a): a is DatasetAnalysis => a !== undefined)

  const activeAnalysis = analyses.find((a) => a.id === selectedAnalysisId)

  const handleStartRename = useCallback((id: string, name: string) => {
    setRenamingId(id)
    setRenameDraft(name)
  }, [])

  const handleFinishRename = useCallback(() => {
    if (renamingId && renameDraft.trim()) {
      useDatasetStore.getState().renameAnalysis(renamingId, renameDraft.trim())
    }
    setRenamingId(null)
  }, [renamingId, renameDraft])

  if (openAnalyses.length === 0 && analyses.length === 0) {
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

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex items-center border-b bg-muted/30 overflow-x-auto">
        {openAnalyses.map((analysis) => {
          const isActive = analysis.id === selectedAnalysisId
          const isDirty = _dirtyVersion >= 0 && isAnalysisDirty(analysis.id)
          return (
            <div
              key={analysis.id}
              className={cn(
                'group flex items-center gap-1 border-r px-2 py-1 text-xs cursor-pointer shrink-0',
                isActive
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
              onClick={() => selectAnalysis(analysis.id)}
              onDoubleClick={() => handleStartRename(analysis.id, analysis.name)}
            >
              {isDirty && (
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shrink-0" />
              )}
              {renamingId === analysis.id ? (
                <input
                  autoFocus
                  className="w-20 border-0 bg-transparent text-xs outline-none"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={handleFinishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <span className="truncate max-w-[120px]">{analysis.name}</span>
              )}
              <button
                className="ml-1 opacity-0 group-hover:opacity-100 hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  closeAnalysis(analysis.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 mx-1"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} />
        </Button>
      </div>

      {/* Content */}
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
