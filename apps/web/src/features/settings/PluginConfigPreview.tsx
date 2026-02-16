import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import type { PluginConfigField } from '@/types/analysis-plugin'
import type { DatasetColumn } from '@/types'

/** Sample columns for preview when no test dataset is loaded. */
const SAMPLE_COLUMNS: DatasetColumn[] = [
  { id: 'col-age', name: 'age', type: 'number', order: 0 },
  { id: 'col-sex', name: 'sex', type: 'string', order: 1 },
  { id: 'col-weight', name: 'weight', type: 'number', order: 2 },
  { id: 'col-height', name: 'height', type: 'number', order: 3 },
  { id: 'col-diagnosis', name: 'diagnosis', type: 'string', order: 4 },
  { id: 'col-admission', name: 'admission_date', type: 'date', order: 5 },
]

export function PluginConfigPreview({ columns }: { columns?: DatasetColumn[] }) {
  const { t } = useTranslation()
  const { files, testConfig, setTestConfig } = usePluginEditorStore()

  const parsed = useMemo(() => {
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      const schema = (manifest.configSchema ?? {}) as Record<string, PluginConfigField>
      return { schema, error: null }
    } catch (err) {
      return { schema: null, error: err instanceof Error ? err.message : String(err) }
    }
  }, [files])

  if (parsed.error) {
    return (
      <div className="flex items-start gap-2 p-4">
        <AlertCircle size={14} className="shrink-0 text-destructive mt-0.5" />
        <div className="space-y-1">
          <p className="text-xs font-medium text-destructive">{t('plugins.invalid_json')}</p>
          <pre className="text-[10px] text-destructive/80 whitespace-pre-wrap">{parsed.error}</pre>
        </div>
      </div>
    )
  }

  if (!parsed.schema || Object.keys(parsed.schema).length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('plugins.no_config_schema')}
      </div>
    )
  }

  const previewColumns = columns ?? SAMPLE_COLUMNS

  return (
    <GenericConfigPanel
      schema={parsed.schema}
      config={testConfig}
      columns={previewColumns}
      onConfigChange={(changes) => setTestConfig({ ...testConfig, ...changes })}
    />
  )
}
