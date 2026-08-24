import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ArrowLeft, ArrowRight, Code, Workflow, Table2, Database, BookOpen, GitCompare } from 'lucide-react'
import { useResolvedParams } from '@/hooks/use-resolved-params'
import { useUrlTab } from '@/hooks/use-url-tab'
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
import { EtlQualityTab } from './EtlQualityTab'
import { vocabularyReadiness } from './vocabulary-readiness'
import { localized } from '@/lib/localized'

const TAB_IDS = ['pipeline', 'scripts', 'schemas', 'vocabulary', 'quality'] as const
type TabId = (typeof TAB_IDS)[number]

const TABS: { id: TabId; labelKey: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'pipeline', labelKey: 'etl.tab_pipeline', icon: Workflow },
  { id: 'scripts', labelKey: 'etl.tab_scripts', icon: Code },
  { id: 'schemas', labelKey: 'etl.tab_schemas', icon: Table2 },
  { id: 'vocabulary', labelKey: 'etl.tab_vocabulary', icon: BookOpen },
  { id: 'quality', labelKey: 'etl.tab_quality', icon: GitCompare },
]

interface Props {
  pipelineId: string
}

export function EtlPipelinePage({ pipelineId }: Props) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { wsUid } = useResolvedParams()
  const { etlPipelines, etlPipelinesLoaded, loadEtlPipelines, loadPipelineFiles, updatePipeline, files, filesLoaded, activePipelineId } = useEtlStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const dbSources = dataSources.filter((ds) => ds.sourceType === 'database' && !ds.isVocabularyReference)

  const [activeTab, setActiveTab] = useUrlTab<TabId>({
    key: `etl:${pipelineId}`,
    tabs: TAB_IDS,
    defaultTab: 'pipeline',
  })
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
  }, [setActiveTab])

  /** "Browse schema" in the scripts editor: same view as the Schemas tab, so go
   *  there on the right database instead of opening a modal over the editor. */
  const handleBrowseSchema = useCallback((dataSourceId: string) => {
    setSchemasDbId(dataSourceId)
    setActiveTab('schemas')
  }, [setActiveTab])

  /**
   * Why the Vocabulary tab needs attention, if it does.
   *
   * Above the early returns because it reads the store (Rules of Hooks). Both
   * causes are what a git-imported pipeline arrives in: the mapping project is
   * instance-local, and the STCM export is gitignored so it never travels.
   */
  const vocabAttention = useMemo(() => {
    if (!fullPipelineId) return undefined
    // Only judge the exports once THIS pipeline's files are in: before that the
    // store is empty (or still holds the previous pipeline's), and every export
    // would look missing — a false amber dot on every open.
    const loaded = filesLoaded && activePipelineId === fullPipelineId
    const own = files.filter((f) => f.pipelineId === fullPipelineId)
    if (loaded && !vocabularyReadiness(own).ready) {
      return 'etl.attention_vocab_export_missing'
    }
    return pipeline?.mappingProjectId ? undefined : 'etl.attention_no_mapping_project'
  }, [files, filesLoaded, activePipelineId, fullPipelineId, pipeline?.mappingProjectId])

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

  /**
   * Which tabs need attention, and why (an i18n key for the dot's tooltip).
   *
   * Both cases are what a git-imported pipeline arrives in: the databases are
   * instance-local so they never travel, and the mapping project is local too.
   * Computed here rather than inside each tab so the dot is visible before the
   * user opens the tab that has the problem.
   */
  const needsAttention: Partial<Record<TabId, string>> = {
    ...(pipeline.sourceDataSourceId && pipeline.targetDataSourceId
      ? {}
      : { pipeline: 'etl.attention_databases' }),
    // A missing export outranks a missing mapping project: it is the more
    // specific problem, and the one whose run-time error names nothing useful.
    ...(vocabAttention ? { vocabulary: vocabAttention } : {}),
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
              {/* An amber dot for a tab that needs attention before the pipeline can
                  run. A freshly git-imported pipeline has neither databases nor a
                  dictionary, and without this the first sign of it was a SQL error
                  from a script whose message says nothing about the cause. */}
              {needsAttention[tab.id] && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  title={t(needsAttention[tab.id]!)}
                  aria-label={t(needsAttention[tab.id]!)}
                />
              )}
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
                  {localized(ds.name, i18n.language)}
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
                  {localized(ds.name, i18n.language)}
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
          <EtlPipelineTab
            pipelineId={pipeline.id}
            onSelectFile={handleSelectFile}
            onBrowseSchema={handleBrowseSchema}
          />
        )}
        {activeTab === 'schemas' && (
          <EtlSchemasTab pipelineId={pipeline.id} initialDataSourceId={schemasDbId} />
        )}
        {activeTab === 'vocabulary' && <EtlVocabularyTab pipelineId={pipeline.id} />}
        {activeTab === 'quality' && <EtlQualityTab pipelineId={pipeline.id} />}
      </div>
    </div>
  )
}
