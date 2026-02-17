import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { AnalysisOutputRenderer } from '@/features/projects/lab/datasets/analyses/AnalysisOutputRenderer'
import { resolveTemplate } from '@/lib/analysis-plugins/template-resolver'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { PluginConfigPreview } from './PluginConfigPreview'
import type { PluginConfigField } from '@/types/analysis-plugin'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'

interface PluginTestPanelProps {
  activeTab: 'config' | 'code' | 'results'
  isExecuting: boolean
  result: RuntimeOutput | null
  statusMessage: string | null
  columns: DatasetColumn[]
}

export function PluginTestPanel({ activeTab, isExecuting, result, statusMessage, columns }: PluginTestPanelProps) {
  const { t } = useTranslation()
  const { files, testLanguage, testConfig } = usePluginEditorStore()

  const parsedSchema = useMemo(() => {
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      return (manifest.configSchema ?? {}) as Record<string, PluginConfigField>
    } catch { return {} }
  }, [files])

  // Resolve template code for preview
  const resolvedCode = useMemo(() => {
    let template = ''
    for (const [filename, content] of Object.entries(files)) {
      if (testLanguage === 'python' && filename.endsWith('.py.template')) { template = content; break }
      if (testLanguage === 'r' && filename.endsWith('.R.template')) { template = content; break }
    }
    if (!template) return ''
    try {
      return resolveTemplate(template, testConfig, columns, parsedSchema, testLanguage)
    } catch { return template }
  }, [files, testLanguage, testConfig, columns, parsedSchema])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === 'config' && (
          <PluginConfigPreview columns={columns.length > 0 ? columns : undefined} />
        )}

        {activeTab === 'code' && (
          <div className="h-full">
            {resolvedCode ? (
              <CodeEditor
                value={resolvedCode}
                language={testLanguage === 'r' ? 'r' : 'python'}
                readOnly
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t('plugins.test_no_template')}
              </div>
            )}
          </div>
        )}

        {activeTab === 'results' && (
          <div className="h-full">
            {(result || isExecuting) ? (
              <AnalysisOutputRenderer
                result={result}
                isExecuting={isExecuting}
                statusMessage={statusMessage}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t('plugins.test_no_results')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
