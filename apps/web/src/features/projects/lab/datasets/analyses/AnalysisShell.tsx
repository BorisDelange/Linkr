import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Play, RotateCcw, Settings, Code2, Eye, EyeOff, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { useDatasetStore } from '@/stores/dataset-store'
import { executeAnalysisCode, executeAnalysisCodeR } from '../analysis-executor'
import { ensurePluginDependencies } from '@/lib/analysis-plugins/registry'
import { AnalysisOutputRenderer } from './AnalysisOutputRenderer'
import type { DatasetAnalysis } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'

interface AnalysisShellProps {
  analysis: DatasetAnalysis
  configPanel: (onConfigChange: (changes: Record<string, unknown>) => void) => React.ReactNode
  generatedCode: string
  language?: 'python' | 'r'
}

export function AnalysisShell({ analysis, configPanel, generatedCode, language = 'python' }: AnalysisShellProps) {
  const { t } = useTranslation()
  const { files, getFileRows, updateAnalysis, saveAnalysis, isAnalysisDirty, _dirtyVersion } = useDatasetStore()

  const autoRun = (analysis.config.autoRun as boolean) ?? false

  // null = left pane hidden; 'config' | 'code' = left pane visible with that tab
  const [activeTab, setActiveTab] = useState<'config' | 'code' | null>(autoRun ? null : 'config')
  const [isExecuting, setIsExecuting] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [installedDeps, setInstalledDeps] = useState<string[]>([])
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false)
  const [rightVisible, setRightVisible] = useState(true)
  const pendingConfigChange = useRef<Record<string, unknown> | null>(null)
  const hasAutoRun = useRef(false)
  const leftVisible = activeTab !== null

  const config = analysis.config
  const isCustomized = (config.isCodeCustomized as boolean) ?? false
  const userCode = config.userCode as string | undefined
  const currentCode = isCustomized && userCode ? userCode : generatedCode

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []

  // Handle code editing in Monaco
  const handleCodeChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return
      if (value === generatedCode) {
        updateAnalysis(analysis.id, {
          config: { ...config, isCodeCustomized: false, userCode: undefined },
        })
      } else {
        updateAnalysis(analysis.id, {
          config: { ...config, isCodeCustomized: true, userCode: value },
        })
      }
    },
    [analysis.id, config, generatedCode, updateAnalysis],
  )

  // Reset code to generated version
  const handleResetCode = useCallback(() => {
    updateAnalysis(analysis.id, {
      config: { ...config, isCodeCustomized: false, userCode: undefined },
    })
  }, [analysis.id, config, updateAnalysis])

  // Save analysis config
  const handleSave = useCallback(() => {
    saveAnalysis(analysis.id)
  }, [analysis.id, saveAnalysis])

  const isDirty = _dirtyVersion >= 0 && isAnalysisDirty(analysis.id)

  // Run the analysis
  const isExecutingRef = useRef(false)
  const handleRun = useCallback(async () => {
    if (isExecutingRef.current) return
    isExecutingRef.current = true
    setIsExecuting(true)
    setResult(null)
    setStatusMessage(null)
    setRightVisible(true)
    try {
      // Auto-install declared plugin dependencies (only checks once per session)
      const newlyInstalled = await ensurePluginDependencies(analysis.type, language, (msg) => setStatusMessage(msg))
      setInstalledDeps(newlyInstalled)
      setStatusMessage(null)

      const rows = getFileRows(analysis.datasetFileId)
      const exec = language === 'r' ? executeAnalysisCodeR : executeAnalysisCode
      const output = await exec(currentCode, rows, columns)
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
  }, [currentCode, analysis.type, analysis.datasetFileId, columns, getFileRows, language])

  // Auto-run on mount (once)
  useEffect(() => {
    if (autoRun && !hasAutoRun.current && columns.length > 0) {
      hasAutoRun.current = true
      handleRun()
    }
  }, [autoRun, columns.length, handleRun])

  // Toggle auto-run
  const handleToggleAutoRun = useCallback(() => {
    updateAnalysis(analysis.id, {
      config: { ...config, autoRun: !autoRun },
    })
  }, [analysis.id, config, autoRun, updateAnalysis])

  // Handle config change from config panel — warn if code is customized
  const handleConfigChange = useCallback(
    (changes: Record<string, unknown>) => {
      const newConfig = { ...config, ...changes }
      if (isCustomized) {
        pendingConfigChange.current = newConfig
        setOverwriteConfirmOpen(true)
      } else {
        updateAnalysis(analysis.id, { config: newConfig })
      }
    },
    [analysis.id, config, isCustomized, updateAnalysis],
  )

  const handleConfirmOverwrite = useCallback(() => {
    if (pendingConfigChange.current) {
      const newConfig = {
        ...pendingConfigChange.current,
        isCodeCustomized: false,
        userCode: undefined,
      }
      updateAnalysis(analysis.id, { config: newConfig })
      pendingConfigChange.current = null
    }
    setOverwriteConfirmOpen(false)
  }, [analysis.id, updateAnalysis])

  const handleCancelOverwrite = useCallback(() => {
    pendingConfigChange.current = null
    setOverwriteConfirmOpen(false)
  }, [])

  return (
    <>
      <div className="flex h-full flex-col">
        {/* Top toolbar: Config/Code toggle tabs + Run + output toggle */}
        <div className="flex items-center gap-1 border-b px-2 py-1">
          <button
            onClick={() => {
              if (activeTab === 'config') {
                if (rightVisible) setActiveTab(null)
              } else {
                setActiveTab('config')
              }
            }}
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
          <button
            onClick={() => {
              if (activeTab === 'code') {
                if (rightVisible) setActiveTab(null)
              } else {
                setActiveTab('code')
              }
            }}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              activeTab === 'code'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50',
            )}
          >
            <Code2 size={12} />
            {t('datasets.analysis_code_tab')}
            {isCustomized && (
              <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">
                {t('datasets.analysis_code_modified_badge')}
              </Badge>
            )}
          </button>

          <div className="ml-auto flex items-center gap-1">
            {isDirty && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleSave}
                    className="h-6 gap-1 text-xs"
                  >
                    <Save size={12} />
                    {t('datasets.analysis_save')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('datasets.analysis_save_tooltip')}</TooltipContent>
              </Tooltip>
            )}
            <Button
              size="sm"
              onClick={handleRun}
              disabled={isExecuting}
              className="h-6 gap-1 text-xs"
            >
              <Play size={12} />
              {isExecuting ? t('datasets.analysis_running') : t('datasets.analysis_run')}
            </Button>
            {isCustomized && (
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

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleToggleAutoRun}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors',
                    autoRun
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <Play size={10} />
                  {t('datasets.analysis_auto_run')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('datasets.analysis_auto_run_tooltip')}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={rightVisible ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  onClick={() => {
                    if (!rightVisible || leftVisible) setRightVisible(!rightVisible)
                  }}
                >
                  {rightVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('datasets.analysis_toggle_output')}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Content: Allotment split */}
        <div className="min-h-0 flex-1">
          <Allotment proportionalLayout={false}>
            {/* Left: Config/Code */}
            <Allotment.Pane preferredSize="45%" minSize={leftVisible ? 200 : 0} visible={leftVisible}>
              <div className="flex h-full flex-col border-r">
                <div className="min-h-0 flex-1 overflow-auto">
                  {activeTab === 'config' && configPanel(handleConfigChange)}
                  {activeTab === 'code' && (
                    <CodeEditor
                      value={currentCode}
                      language={language}
                      onChange={handleCodeChange}
                      height="100%"
                      onRunSelectionOrLine={handleRun}
                      onRunFile={handleRun}
                    />
                  )}
                </div>
              </div>
            </Allotment.Pane>

            {/* Right: Output */}
            <Allotment.Pane minSize={rightVisible ? 200 : 0} visible={rightVisible}>
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

      {/* Overwrite confirmation dialog */}
      <AlertDialog open={overwriteConfirmOpen} onOpenChange={setOverwriteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('datasets.analysis_overwrite_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('datasets.analysis_overwrite_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelOverwrite}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmOverwrite}>
              {t('datasets.analysis_overwrite_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
