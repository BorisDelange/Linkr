import { useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Play, RotateCcw, Settings, Code2, Eye, EyeOff } from 'lucide-react'
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
import { executeAnalysisCode } from '../analysis-executor'
import { AnalysisOutputRenderer } from './AnalysisOutputRenderer'
import type { DatasetAnalysis } from '@/types'
import type { RuntimeOutput } from '@/lib/runtimes/types'

interface AnalysisShellProps {
  analysis: DatasetAnalysis
  configPanel: React.ReactNode
  generatedCode: string
}

export function AnalysisShell({ analysis, configPanel, generatedCode }: AnalysisShellProps) {
  const { t } = useTranslation()
  const { files, getFileRows, updateAnalysis, _dirtyVersion } = useDatasetStore()

  // null = left pane hidden; 'config' | 'code' = left pane visible with that tab
  const [activeTab, setActiveTab] = useState<'config' | 'code' | null>('config')
  const [isExecuting, setIsExecuting] = useState(false)
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false)
  const [rightVisible, setRightVisible] = useState(true)
  const pendingConfigChange = useRef<Record<string, unknown> | null>(null)
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

  // Run the analysis
  const handleRun = useCallback(async () => {
    setIsExecuting(true)
    setResult(null)
    setRightVisible(true)
    try {
      const rows = getFileRows(analysis.datasetFileId)
      const output = await executeAnalysisCode(currentCode, rows, columns)
      setResult(output)
    } catch (err) {
      console.error('[AnalysisShell] execution error:', err)
      setResult({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        figures: [],
        table: null,
        html: null,
      })
    } finally {
      setIsExecuting(false)
    }
  }, [currentCode, analysis.datasetFileId, columns, getFileRows])

  // Handle config change from parent — warn if code is customized
  const handleConfigChangeFromParent = useCallback(
    (newConfig: Record<string, unknown>) => {
      if (isCustomized) {
        pendingConfigChange.current = newConfig
        setOverwriteConfirmOpen(true)
      } else {
        updateAnalysis(analysis.id, { config: newConfig })
      }
    },
    [analysis.id, isCustomized, updateAnalysis],
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
                  {activeTab === 'config' && configPanel}
                  {activeTab === 'code' && (
                    <CodeEditor
                      value={currentCode}
                      language="python"
                      onChange={handleCodeChange}
                      height="100%"
                    />
                  )}
                </div>
              </div>
            </Allotment.Pane>

            {/* Right: Output */}
            <Allotment.Pane minSize={rightVisible ? 200 : 0} visible={rightVisible}>
              <AnalysisOutputRenderer result={result} isExecuting={isExecuting} />
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
