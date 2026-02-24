import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Settings, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { getComponent } from '@/lib/plugins/component-registry'
import type { DatasetAnalysis } from '@/types'

interface ComponentAnalysisShellProps {
  analysis: DatasetAnalysis
  configPanel: (onConfigChange: (changes: Record<string, unknown>) => void) => React.ReactNode
  componentId: string
}

export function ComponentAnalysisShell({ analysis, configPanel, componentId }: ComponentAnalysisShellProps) {
  const { t } = useTranslation()
  const { files, getFileRows, updateAnalysis, saveAnalysis, isAnalysisDirty, _dirtyVersion } = useDatasetStore()

  const [configVisible, setConfigVisible] = useState(true)

  const config = analysis.config
  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const rows = getFileRows(analysis.datasetFileId)

  const isDirty = _dirtyVersion >= 0 && isAnalysisDirty(analysis.id)

  const handleConfigChange = useCallback(
    (changes: Record<string, unknown>) => {
      updateAnalysis(analysis.id, { config: { ...config, ...changes } })
    },
    [analysis.id, config, updateAnalysis],
  )

  const handleSave = useCallback(() => {
    saveAnalysis(analysis.id)
  }, [analysis.id, saveAnalysis])

  const Component = getComponent(componentId)

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <button
          onClick={() => setConfigVisible(!configVisible)}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
            configVisible
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <Settings size={12} />
          {t('datasets.analysis_config_tab')}
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
        </div>
      </div>

      {/* Content: Allotment split */}
      <div className="min-h-0 flex-1">
        <Allotment proportionalLayout={false}>
          {/* Left: Config */}
          <Allotment.Pane preferredSize="35%" minSize={configVisible ? 200 : 0} visible={configVisible}>
            <div className="flex h-full flex-col border-r">
              <div className="min-h-0 flex-1 overflow-auto">
                {configPanel(handleConfigChange)}
              </div>
            </div>
          </Allotment.Pane>

          {/* Right: Live component */}
          <Allotment.Pane minSize={200}>
            <div className="h-full overflow-auto">
              {Component ? (
                <Component config={config} columns={columns} rows={rows} />
              ) : (
                <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
                  Component not found: {componentId}
                </div>
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  )
}
