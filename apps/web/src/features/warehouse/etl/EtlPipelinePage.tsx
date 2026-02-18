import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, Code, Workflow, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import { EtlScriptsTab } from './EtlScriptsTab'

type TabId = 'scripts' | 'pipeline' | 'profiling'

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'scripts', labelKey: 'etl.tab_scripts', icon: Code },
  { id: 'pipeline', labelKey: 'etl.tab_pipeline', icon: Workflow },
  { id: 'profiling', labelKey: 'etl.tab_profiling', icon: BarChart3 },
]

interface Props {
  pipelineId: string
}

export function EtlPipelinePage({ pipelineId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { etlPipelines, etlPipelinesLoaded, loadEtlPipelines, loadPipelineFiles } = useEtlStore()

  const [activeTab, setActiveTab] = useState<TabId>('scripts')

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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with back button + pipeline name + tabs */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button variant="ghost" size="icon-xs" onClick={() => navigate('..')}>
          <ArrowLeft size={14} />
        </Button>
        <span className="truncate text-sm font-medium">{pipeline.name}</span>

        <div className="ml-4 flex items-center gap-0.5">
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
      </div>

      {/* Tab content — full remaining space */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'scripts' && <EtlScriptsTab pipelineId={pipelineId} />}
        {activeTab === 'pipeline' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('etl.pipeline_tab_coming_soon')}
          </div>
        )}
        {activeTab === 'profiling' && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('etl.profiling_tab_coming_soon')}
          </div>
        )}
      </div>
    </div>
  )
}
