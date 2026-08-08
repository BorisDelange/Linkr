import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Code, Workflow, Table2, Database, BookOpen } from 'lucide-react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useEtlStore } from '@/stores/etl-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { EtlScriptsTab } from './EtlScriptsTab'
import { EtlPipelineTab } from './EtlPipelineTab'
import { EtlSchemasTab } from './EtlSchemasTab'
import { EtlVocabularyTab } from './EtlVocabularyTab'

type TabId = 'scripts' | 'pipeline' | 'schemas' | 'vocabulary'

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'pipeline', labelKey: 'etl.tab_pipeline', icon: Workflow },
  { id: 'scripts', labelKey: 'etl.tab_scripts', icon: Code },
  { id: 'schemas', labelKey: 'etl.tab_schemas', icon: Table2 },
  { id: 'vocabulary', labelKey: 'etl.tab_vocabulary', icon: BookOpen },
]

interface Props {
  pipelineId: string
}

export function EtlPipelinePage({ pipelineId }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const { etlPipelines, etlPipelinesLoaded, loadEtlPipelines, loadPipelineFiles, updatePipeline } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [activeTab, setActiveTab] = useState<TabId>('pipeline')
  // Database the schemas tab should open on when the scripts tab sends the user
  // there ("Browse schema"), rather than its own default.
  const [schemasDbId, setSchemasDbId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!etlPipelinesLoaded) loadEtlPipelines()
  }, [etlPipelinesLoaded, loadEtlPipelines])

  // pipelineId may be a short prefix from the URL; resolve to the full id before any store call.
  const pipeline = resolveByIdPrefix(etlPipelines, pipelineId, (p) => p.id)
  const fullPipelineId = pipeline?.id

  useEffect(() => {
    if (fullPipelineId) loadPipelineFiles(fullPipelineId)
  }, [fullPipelineId, loadPipelineFiles])

  // When clicking a script node in the pipeline DAG, switch to scripts tab and
  // select the file. Must stay above the early returns (Rules of Hooks).
  const handleSelectFile = useCallback((fileId: string) => {
    const { selectFile } = useEtlStore.getState()
    selectFile(fileId)
    setActiveTab('scripts')
  }, [])

  /** "Browse schema" in the scripts editor: same view as the Schemas tab, so go
   *  there on the right database instead of opening a modal over the editor. */
  const handleBrowseSchema = useCallback((dataSourceId: string) => {
    setSchemasDbId(dataSourceId)
    setActiveTab('schemas')
  }, [])

  if (!etlPipelinesLoaded) return null

  if (!pipeline) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('etl.pipeline_not_found')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => navigate(paths.warehouseEtl(wsUid ?? ''))}>
          <ArrowLeft size={14} />
          {t('etl.back_to_list')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header with pipeline tabs */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
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
              <SelectValue placeholder={t('etl.select_source')} />
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
        {activeTab === 'scripts' && (
          <EtlScriptsTab pipelineId={pipeline.id} onBrowseSchema={handleBrowseSchema} />
        )}
        {activeTab === 'pipeline' && (
          <EtlPipelineTab pipelineId={pipeline.id} onSelectFile={handleSelectFile} />
        )}
        {activeTab === 'schemas' && (
          <EtlSchemasTab pipelineId={pipeline.id} initialDataSourceId={schemasDbId} />
        )}
        {activeTab === 'vocabulary' && <EtlVocabularyTab pipelineId={pipeline.id} />}
      </div>
    </div>
  )
}
