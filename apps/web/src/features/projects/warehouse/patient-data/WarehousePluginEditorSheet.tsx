import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Play, RotateCcw, Settings, Code2, X, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { getPlugin, ensurePluginDependencies } from '@/lib/plugins/registry'
import {
  usePatientChartStore,
  type PluginWidgetConfig,
} from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { buildTimelineQuery, buildPatientVisitSummaryQuery } from '@/lib/duckdb/patient-data-queries'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { PluginConfigField } from '@/types/plugin'

interface WarehousePluginEditorSheetProps {
  widgetId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WarehousePluginEditorSheet({ widgetId, open, onOpenChange }: WarehousePluginEditorSheetProps) {
  const widget = usePatientChartStore((s) =>
    widgetId ? s.widgets.find((w) => w.id === widgetId) : undefined,
  )

  if (!widget) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[80vw] max-w-5xl sm:max-w-5xl p-0 gap-0"
      >
        <EditorContent widget={widget} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Editor content
// ---------------------------------------------------------------------------

function EditorContent({
  widget,
  onClose,
}: {
  widget: { id: string; name: string; config: Record<string, unknown> }
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as 'en' | 'fr'
  const { dataSourceId, schemaMapping, projectUid } = usePatientChartContext()
  const updateWidgetConfig = usePatientChartStore((s) => s.updateWidgetConfig)

  const config = widget.config as PluginWidgetConfig | undefined
  const pluginId = config?.pluginId
  const plugin = pluginId ? getPlugin(pluginId) : null

  const pluginName = plugin
    ? (plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.manifest.id)
    : ''

  const configSchema = plugin?.manifest.configSchema ?? {}
  const hasConfigSchema = Object.keys(configSchema).length > 0
  const needsConceptPicker = plugin?.manifest.needsConceptPicker ?? false

  // Language
  const language: 'python' | 'r' = config?.language ?? (plugin?.templates?.python ? 'python' : 'r')

  // Local plugin config state
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>(config?.pluginConfig ?? {})

  // Code customization state
  const [isCodeCustomized, setIsCodeCustomized] = useState(
    (config?.pluginConfig?.isCodeCustomized as boolean) ?? false,
  )
  const [userCode, setUserCode] = useState(
    (config?.pluginConfig?.userCode as string) ?? '',
  )

  // Tab state
  const [activeTab, setActiveTab] = useState<'config' | 'code' | null>(hasConfigSchema || needsConceptPicker ? 'config' : 'code')

  // Concept picker state
  const [conceptPickerOpen, setConceptPickerOpen] = useState(false)
  const conceptIds = (pluginConfig.conceptIds as number[] | undefined) ?? []

  // Patient context
  const selectedPatientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const selectedVisitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const selectedVisitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)

  // Execution state
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [installedDeps, setInstalledDeps] = useState<string[]>([])
  const isExecutingRef = useRef(false)

  // Reset state when widget changes
  useEffect(() => {
    const cfg = widget.config as PluginWidgetConfig | undefined
    setPluginConfig(cfg?.pluginConfig ?? {})
    setIsCodeCustomized((cfg?.pluginConfig?.isCodeCustomized as boolean) ?? false)
    setUserCode((cfg?.pluginConfig?.userCode as string) ?? '')
    setResult(null)
  }, [widget.id])

  // Generate code from template
  const generatedCode = useGeneratedCode(plugin, pluginConfig, language)
  const currentCode = isCodeCustomized && userCode ? userCode : generatedCode

  // Build extra preamble for needsConceptPicker plugins
  const extraPreamble = useMemo(() => {
    if (!plugin?.manifest.needsConceptPicker || !schemaMapping || !selectedPatientId) return undefined
    const ids = pluginConfig.conceptIds as number[] | undefined
    const timelineSql = ids?.length
      ? buildTimelineQuery(schemaMapping, ids, selectedPatientId, selectedVisitId)
      : null
    const visitSummarySql = buildPatientVisitSummaryQuery(schemaMapping, selectedPatientId)

    if (language === 'python') {
      return [
        `timeline_sql = ${timelineSql ? JSON.stringify(timelineSql) : 'None'}`,
        `visit_summary_sql = ${visitSummarySql ? JSON.stringify(visitSummarySql) : 'None'}`,
        '',
      ].join('\n')
    }
    return [
      `timeline_sql <- ${timelineSql ? JSON.stringify(timelineSql) : 'NULL'}`,
      `visit_summary_sql <- ${visitSummarySql ? JSON.stringify(visitSummarySql) : 'NULL'}`,
      '',
    ].join('\n')
  }, [plugin, schemaMapping, selectedPatientId, selectedVisitId, pluginConfig, language])

  // Persist changes to store
  const persistConfig = useCallback((newPluginConfig: Record<string, unknown>) => {
    if (!config) return
    updateWidgetConfig(widget.id, {
      ...config,
      pluginConfig: newPluginConfig,
    })
  }, [widget.id, config, updateWidgetConfig])

  // Config changes
  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    const newConfig = { ...pluginConfig, ...changes }
    setPluginConfig(newConfig)
    if (isCodeCustomized) {
      setIsCodeCustomized(false)
      setUserCode('')
      persistConfig({ ...newConfig, isCodeCustomized: false, userCode: undefined })
    } else {
      persistConfig(newConfig)
    }
  }, [pluginConfig, isCodeCustomized, persistConfig])

  // Concept confirm
  const handleConceptsConfirm = useCallback((ids: number[]) => {
    const newConfig = { ...pluginConfig, conceptIds: ids }
    setPluginConfig(newConfig)
    persistConfig(newConfig)
    setConceptPickerOpen(false)
  }, [pluginConfig, persistConfig])

  // Language change
  const handleLanguageChange = useCallback((newLang: 'python' | 'r') => {
    if (!config) return
    updateWidgetConfig(widget.id, {
      ...config,
      language: newLang,
    })
    // Reset code customization when language changes
    setIsCodeCustomized(false)
    setUserCode('')
    persistConfig({ ...pluginConfig, isCodeCustomized: false, userCode: undefined })
  }, [widget.id, config, updateWidgetConfig, pluginConfig, persistConfig])

  // Code editing
  const handleCodeChange = useCallback((value: string | undefined) => {
    if (value === undefined) return
    if (value === generatedCode) {
      setIsCodeCustomized(false)
      setUserCode('')
      persistConfig({ ...pluginConfig, isCodeCustomized: false, userCode: undefined })
    } else {
      setIsCodeCustomized(true)
      setUserCode(value)
      persistConfig({ ...pluginConfig, isCodeCustomized: true, userCode: value })
    }
  }, [generatedCode, pluginConfig, persistConfig])

  const handleResetCode = useCallback(() => {
    setIsCodeCustomized(false)
    setUserCode('')
    persistConfig({ ...pluginConfig, isCodeCustomized: false, userCode: undefined })
  }, [pluginConfig, persistConfig])

  // Run execution
  const handleRun = useCallback(async () => {
    if (isExecutingRef.current || !plugin || !dataSourceId) return
    isExecutingRef.current = true
    setIsExecuting(true)
    setResult(null)
    setStatusMessage(null)

    try {
      const newlyInstalled = await ensurePluginDependencies(plugin.manifest.id, language, (msg) => setStatusMessage(msg))
      setInstalledDeps(newlyInstalled)
      setStatusMessage(null)

      const executor = await import('./warehouse-plugin-executor')
      const exec = language === 'r'
        ? executor.executeWarehousePluginR
        : executor.executeWarehousePluginPython

      const output = await exec(
        currentCode,
        dataSourceId,
        selectedPatientId,
        selectedVisitId,
        selectedVisitDetailId,
        extraPreamble,
      )
      setResult(output)
    } catch (err) {
      setResult({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        figures: [],
        table: null,
        html: null,
      })
    } finally {
      isExecutingRef.current = false
      setIsExecuting(false)
      setStatusMessage(null)
    }
  }, [currentCode, dataSourceId, selectedPatientId, selectedVisitId, selectedVisitDetailId, language, plugin, extraPreamble])

  const leftVisible = activeTab !== null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SheetHeader className="flex-row items-center gap-2 border-b px-3 py-2 space-y-0">
        <SheetTitle className="text-sm truncate">{pluginName || widget.name}</SheetTitle>
        <div className="flex-1" />
        {/* Language selector */}
        {plugin?.templates?.python && plugin?.templates?.r && (
          <Select value={language} onValueChange={(v) => handleLanguageChange(v as 'python' | 'r')}>
            <SelectTrigger className="h-6 w-auto gap-1 text-xs border-dashed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={4}>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="r">R</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={14} />
        </Button>
      </SheetHeader>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {(hasConfigSchema || needsConceptPicker) && (
          <button
            onClick={() => setActiveTab(activeTab === 'config' ? null : 'config')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              activeTab === 'config'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            <Settings size={12} />
            {t('datasets.analysis_config_tab')}
          </button>
        )}
        <button
          onClick={() => setActiveTab(activeTab === 'code' ? null : 'code')}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            activeTab === 'code'
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <Code2 size={12} />
          {t('datasets.analysis_code_tab')}
          {isCodeCustomized && (
            <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">
              {t('datasets.analysis_code_modified_badge')}
            </Badge>
          )}
        </button>

        <div className="ml-auto flex items-center gap-1">
          {!selectedPatientId && (
            <span className="text-[10px] text-muted-foreground mr-1">
              {t('patient_data.select_patient_first')}
            </span>
          )}
          <Button
            size="sm"
            onClick={handleRun}
            disabled={isExecuting || !selectedPatientId || !dataSourceId}
            className="h-6 gap-1 text-xs"
          >
            <Play size={12} />
            {isExecuting ? t('datasets.analysis_running') : t('datasets.analysis_run')}
          </Button>
          {isCodeCustomized && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleResetCode}
              className="h-6 gap-1 text-xs"
            >
              <RotateCcw size={12} />
              {t('datasets.analysis_reset_code')}
            </Button>
          )}
        </div>
      </div>

      {/* Content: Allotment split */}
      <div className="min-h-0 flex-1">
        <Allotment proportionalLayout={false}>
          <Allotment.Pane preferredSize="45%" minSize={leftVisible ? 200 : 0} visible={leftVisible}>
            <div className="flex h-full flex-col border-r">
              <div className="min-h-0 flex-1 overflow-auto">
                {activeTab === 'config' && (
                  <div className="space-y-4 p-3">
                    {/* Concept picker */}
                    {needsConceptPicker && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => setConceptPickerOpen(true)}
                        >
                          <ListChecks size={14} />
                          {t('patient_data.select_concepts')}
                        </Button>
                        <Badge variant="secondary" className="text-xs">
                          {t('patient_data.concepts_selected', { count: conceptIds.length })}
                        </Badge>
                      </div>
                    )}
                    {/* Config fields */}
                    {hasConfigSchema && (
                      <GenericConfigPanel
                        schema={configSchema as Record<string, PluginConfigField>}
                        config={pluginConfig}
                        columns={[]}
                        onConfigChange={handleConfigChange}
                      />
                    )}
                    {!hasConfigSchema && !needsConceptPicker && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        {t('patient_data.no_plugin_config')}
                      </div>
                    )}
                  </div>
                )}
                {activeTab === 'code' && (
                  <CodeEditor
                    value={currentCode}
                    language={language}
                    onChange={handleCodeChange}
                    height="100%"
                  />
                )}
              </div>
            </div>
          </Allotment.Pane>

          <Allotment.Pane minSize={200}>
            <PluginOutputRenderer
              result={result}
              isExecuting={isExecuting}
              statusMessage={statusMessage}
              installedDeps={installedDeps}
              onRerun={handleRun}
            />
          </Allotment.Pane>
        </Allotment>
      </div>

      {/* Concept picker sub-dialog */}
      {needsConceptPicker && (
        <ConceptPickerDialog
          open={conceptPickerOpen}
          onOpenChange={setConceptPickerOpen}
          selectedConceptIds={conceptIds}
          onConfirm={handleConceptsConfirm}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook: generate code from plugin template + config
// ---------------------------------------------------------------------------

function useGeneratedCode(
  plugin: ReturnType<typeof getPlugin>,
  config: Record<string, unknown>,
  language: 'python' | 'r',
): string {
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!plugin?.templates) {
      setCode('')
      return
    }
    const template = language === 'python' ? plugin.templates.python : plugin.templates.r
    if (!template) {
      setCode('')
      return
    }
    import('@/lib/plugins/template-resolver').then(({ resolveTemplate }) => {
      const resolved = resolveTemplate(
        template,
        config,
        [],
        plugin.manifest.configSchema,
        language,
      )
      setCode(resolved)
    })
  }, [plugin, config, language])

  return code
}
