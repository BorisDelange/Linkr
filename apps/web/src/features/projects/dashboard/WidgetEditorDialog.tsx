import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Play, RotateCcw, Settings, Code2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { AnalysisOutputRenderer } from '@/features/projects/lab/datasets/analyses/AnalysisOutputRenderer'
import { getAnalysisPlugin, ensurePluginDependencies } from '@/lib/analysis-plugins/registry'
import { useDashboardStore } from '@/stores/dashboard-store'
import { useDashboardData } from './DashboardDataProvider'
import type { DashboardWidget, DashboardWidgetSource } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { PluginConfigField } from '@/types/analysis-plugin'

interface WidgetEditorDialogProps {
  widget: DashboardWidget | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WidgetEditorDialog({ widget, open, onOpenChange }: WidgetEditorDialogProps) {
  if (!widget) return null
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[80vw] max-w-5xl sm:max-w-5xl p-0 gap-0"
      >
        <WidgetEditorContent widget={widget} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Editor content
// ---------------------------------------------------------------------------

function WidgetEditorContent({ widget, onClose }: { widget: DashboardWidget; onClose: () => void }) {
  const { t } = useTranslation()
  const { updateWidgetSource } = useDashboardStore()
  const { filteredRows, columns } = useDashboardData()

  const source = widget.source
  const isPlugin = source.type === 'plugin'
  const isInline = source.type === 'inline'

  // Resolve plugin info
  const plugin = isPlugin ? getAnalysisPlugin(source.pluginId) : null
  const hasConfigSchema = plugin?.manifest.configSchema && Object.keys(plugin.manifest.configSchema).length > 0

  // Detect language
  const language: 'python' | 'r' = isInline
    ? ((source.language === 'r' ? 'r' : 'python') as 'python' | 'r')
    : plugin?.templates?.python
      ? 'python'
      : 'r'

  // Local config state
  const [config, setConfig] = useState<Record<string, unknown>>(source.config ?? {})
  const [activeTab, setActiveTab] = useState<'config' | 'code' | null>(hasConfigSchema ? 'config' : 'code')

  // Code state
  const [isCodeCustomized, setIsCodeCustomized] = useState(
    (source.config?.isCodeCustomized as boolean) ?? false,
  )
  const [userCode, setUserCode] = useState(
    (source.config?.userCode as string) ?? '',
  )

  // Execution state
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [installedDeps, setInstalledDeps] = useState<string[]>([])
  const isExecutingRef = useRef(false)

  // Reset state when widget changes
  useEffect(() => {
    setConfig(widget.source.config ?? {})
    setIsCodeCustomized((widget.source.config?.isCodeCustomized as boolean) ?? false)
    setUserCode((widget.source.config?.userCode as string) ?? '')
    setResult(null)
  }, [widget.id])

  // Generate code from template
  const generatedCode = useGeneratedCode(plugin, config, columns, language)
  const currentCode = isInline
    ? ((source as { code: string }).code ?? '')
    : (isCodeCustomized && userCode ? userCode : generatedCode)

  // Persist changes to store
  const persistSource = useCallback((updates: Partial<DashboardWidgetSource>) => {
    const newSource = { ...widget.source, ...updates } as DashboardWidgetSource
    updateWidgetSource(widget.id, newSource)
  }, [widget.id, widget.source, updateWidgetSource])

  // Config changes
  const handleConfigChange = useCallback((changes: Record<string, unknown>) => {
    const newConfig = { ...config, ...changes }
    setConfig(newConfig)
    if (isCodeCustomized) {
      // Reset code customization when config changes
      setIsCodeCustomized(false)
      setUserCode('')
      persistSource({ config: { ...newConfig, isCodeCustomized: false, userCode: undefined } })
    } else {
      persistSource({ config: newConfig })
    }
  }, [config, isCodeCustomized, persistSource])

  // Code editing
  const handleCodeChange = useCallback((value: string | undefined) => {
    if (value === undefined) return
    if (isInline) {
      persistSource({ code: value } as Partial<DashboardWidgetSource>)
    } else {
      if (value === generatedCode) {
        setIsCodeCustomized(false)
        setUserCode('')
        persistSource({ config: { ...config, isCodeCustomized: false, userCode: undefined } })
      } else {
        setIsCodeCustomized(true)
        setUserCode(value)
        persistSource({ config: { ...config, isCodeCustomized: true, userCode: value } })
      }
    }
  }, [isInline, generatedCode, config, persistSource])

  const handleResetCode = useCallback(() => {
    setIsCodeCustomized(false)
    setUserCode('')
    persistSource({ config: { ...config, isCodeCustomized: false, userCode: undefined } })
  }, [config, persistSource])

  // Run execution
  const handleRun = useCallback(async () => {
    if (isExecutingRef.current) return
    isExecutingRef.current = true
    setIsExecuting(true)
    setResult(null)
    setStatusMessage(null)

    try {
      if (isPlugin && plugin) {
        const newlyInstalled = await ensurePluginDependencies(plugin.manifest.id, language, (msg) => setStatusMessage(msg))
        setInstalledDeps(newlyInstalled)
        setStatusMessage(null)
      }

      const executor = await import('@/features/projects/lab/datasets/analysis-executor')
      const exec = language === 'r' ? executor.executeAnalysisCodeR : executor.executeAnalysisCode
      const output = await exec(currentCode, filteredRows, columns)
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
  }, [currentCode, filteredRows, columns, language, isPlugin, plugin])

  const leftVisible = activeTab !== null
  const configSchema = plugin?.manifest.configSchema ?? {}

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <SheetHeader className="flex-row items-center gap-2 border-b px-3 py-2 space-y-0">
        <SheetTitle className="text-sm flex-1 truncate">{widget.name}</SheetTitle>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X size={14} />
        </Button>
      </SheetHeader>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {hasConfigSchema && (
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
          <Button
            size="sm"
            onClick={handleRun}
            disabled={isExecuting}
            className="h-6 gap-1 text-xs"
          >
            <Play size={12} />
            {isExecuting ? t('datasets.analysis_running') : t('datasets.analysis_run')}
          </Button>
          {isCodeCustomized && !isInline && (
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
                {activeTab === 'config' && hasConfigSchema && (
                  <GenericConfigPanel
                    schema={configSchema as Record<string, PluginConfigField>}
                    config={config}
                    columns={columns}
                    onConfigChange={handleConfigChange}
                  />
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
            <AnalysisOutputRenderer
              result={result}
              isExecuting={isExecuting}
              statusMessage={statusMessage}
              installedDeps={installedDeps}
              onRerun={handleRun}
            />
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook: generate code from plugin template + config
// ---------------------------------------------------------------------------

function useGeneratedCode(
  plugin: ReturnType<typeof getAnalysisPlugin>,
  config: Record<string, unknown>,
  columns: { id: string; name: string; type: string }[],
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
    import('@/lib/analysis-plugins/template-resolver').then(({ resolveTemplate }) => {
      const resolved = resolveTemplate(
        template,
        config,
        columns,
        plugin.manifest.configSchema,
        language,
      )
      setCode(resolved)
    })
  }, [plugin, config, columns, language])

  return code
}
