import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Code, Workflow, BarChart3, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { EtlScriptsTab } from './EtlScriptsTab'
import { EtlPipelineTab } from './EtlPipelineTab'
import { EtlProfilingTab } from './EtlProfilingTab'

type TabId = 'scripts' | 'pipeline' | 'profiling'

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'profiling', labelKey: 'etl.tab_profiling', icon: BarChart3 },
  { id: 'scripts', labelKey: 'etl.tab_scripts', icon: Code },
  { id: 'pipeline', labelKey: 'etl.tab_pipeline', icon: Workflow },
]

interface Props {
  pipelineId: string
}

export function EtlPipelinePage({ pipelineId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { etlPipelines, etlPipelinesLoaded, loadEtlPipelines, loadPipelineFiles, updatePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [activeTab, setActiveTab] = useState<TabId>('profiling')

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  useEffect(() => {
    loadPipelineFiles(pipelineId)
  }, [pipelineId, loadPipelineFiles])

  const pipeline = etlPipelines.find((p) => p.id === pipelineId)

  if (!etlPipelinesLoaded) return null

  if (!pipeline) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('etl.pipeline_not_found')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => navigate('..')}>
          <ArrowLeft size={14} />
          {t('etl.back_to_list')}
        </Button>
      </div>
    )
  }

  // When clicking a script node in the pipeline DAG, switch to scripts tab and select the file
  const handleSelectFile = useCallback((fileId: string) => {
    const { selectFile } = useEtlStore.getState()
    selectFile(fileId)
    setActiveTab('scripts')
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with back button + pipeline name + tabs */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button variant="ghost" size="icon-xs" onClick={() => navigate('..')}>
          <ArrowLeft size={14} />
        </Button>
        <span className="truncate text-sm font-medium">{pipeline.name}</span>

        <Separator orientation="vertical" className="!h-4 mx-1" />

        <div className="flex items-center gap-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors',
                activeTab === tab.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <tab.icon size={14} />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Select
            value={pipeline.sourceDataSourceId}
            onValueChange={(value) => updatePipeline(pipeline.id, { sourceDataSourceId: value })}
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
              <Database size={12} className="text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dbSources.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {ds.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ArrowRight size={12} className="shrink-0 text-muted-foreground" />

          <Select
            value={pipeline.targetDataSourceId ?? ''}
            onValueChange={(value) => updatePipeline(pipeline.id, { targetDataSourceId: value || undefined })}
          >
            <SelectTrigger className="h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/50">
              <Database size={12} className="text-muted-foreground" />
              <SelectValue placeholder={t('etl.select_target')} />
            </SelectTrigger>
            <SelectContent>
              {dbSources.map((ds) => (
                <SelectItem key={ds.id} value={ds.id}>
                  {ds.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Tab content — full remaining space */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'scripts' && <EtlScriptsTab pipelineId={pipelineId} />}
        {activeTab === 'pipeline' && (
          <EtlPipelineTab pipelineId={pipelineId} onSelectFile={handleSelectFile} />
        )}
        {activeTab === 'profiling' && <EtlProfilingTab pipelineId={pipelineId} />}
      </div>
    </div>
  )
}
