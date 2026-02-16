import { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useDatasetStore } from '@/stores/dataset-store'
import { generateTable1Code } from '../code-generators/table1'
import { AnalysisShell } from './AnalysisShell'
import type { DatasetAnalysis } from '@/types'

interface Table1AnalysisProps {
  analysis: DatasetAnalysis
}

export function Table1Analysis({ analysis }: Table1AnalysisProps) {
  const { t } = useTranslation()
  const { files, updateAnalysis } = useDatasetStore()

  const file = files.find((f) => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []

  const config = analysis.config
  const selectedColumns = (config.selectedColumns as string[] | undefined) ?? columns.map((c) => c.id)
  const groupByColumn = (config.groupByColumn as string | undefined) ?? ''

  // Generate Python code from config
  const generatedCode = useMemo(
    () => generateTable1Code(config, columns),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(config), JSON.stringify(columns.map((c) => ({ id: c.id, name: c.name, type: c.type })))],
  )

  // Config change handler — respects code customization (AnalysisShell handles the warning)
  const handleConfigChange = useCallback(
    (changes: Record<string, unknown>) => {
      const isCustomized = (config.isCodeCustomized as boolean) ?? false
      if (isCustomized) {
        // AnalysisShell will show the overwrite warning before applying
        // For now, just pass the full new config
      }
      updateAnalysis(analysis.id, {
        config: { ...config, ...changes },
      })
    },
    [analysis.id, config, updateAnalysis],
  )

  const toggleColumn = useCallback(
    (colId: string) => {
      const current = selectedColumns
      const next = current.includes(colId)
        ? current.filter((id) => id !== colId)
        : [...current, colId]
      handleConfigChange({ selectedColumns: next })
    },
    [selectedColumns, handleConfigChange],
  )

  const selectAll = useCallback(() => {
    handleConfigChange({ selectedColumns: columns.map((c) => c.id) })
  }, [columns, handleConfigChange])

  const selectNone = useCallback(() => {
    handleConfigChange({ selectedColumns: [] })
  }, [handleConfigChange])

  // Categorical columns for group-by
  const categoricalColumns = useMemo(
    () => columns.filter((c) => c.type === 'string' || c.type === 'boolean'),
    [columns],
  )

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  const configPanel = (
    <div className="p-3 space-y-4">
      {/* Variables selection */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t('datasets.analysis_variables')}</Label>
          <div className="flex items-center gap-1">
            <button
              onClick={selectAll}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('common.select_all')}
            </button>
            <span className="text-[10px] text-muted-foreground">/</span>
            <button
              onClick={selectNone}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {t('common.select_none')}
            </button>
          </div>
        </div>
        <ScrollArea className="max-h-[200px]">
          <div className="space-y-0.5">
            {columns.map((col) => {
              const isSelected = selectedColumns.includes(col.id)
              return (
                <button
                  key={col.id}
                  onClick={() => toggleColumn(col.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors',
                    isSelected
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <div
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30',
                    )}
                  >
                    {isSelected && <Check size={10} />}
                  </div>
                  <span className="truncate">{col.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{col.type}</span>
                </button>
              )
            })}
          </div>
        </ScrollArea>
        <p className="text-[10px] text-muted-foreground">
          {selectedColumns.length} / {columns.length} {t('datasets.analysis_selected')}
        </p>
      </div>

      {/* Group by */}
      <div className="space-y-1.5">
        <Label className="text-xs">{t('datasets.analysis_group_by')}</Label>
        <Select
          value={groupByColumn || '__none__'}
          onValueChange={(v) => handleConfigChange({ groupByColumn: v === '__none__' ? undefined : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t('datasets.analysis_group_by_none')}</SelectItem>
            {categoricalColumns.map((col) => (
              <SelectItem key={col.id} value={col.name}>
                {col.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )

  return (
    <AnalysisShell
      analysis={analysis}
      configPanel={configPanel}
      generatedCode={generatedCode}
    />
  )
}
