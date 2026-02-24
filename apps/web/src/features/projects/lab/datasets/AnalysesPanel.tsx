import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDatasetStore } from '@/stores/dataset-store'
import { getPlugin } from '@/lib/plugins/registry'
import { resolveTemplate } from '@/lib/plugins/template-resolver'
import { AnalysisShell } from './analyses/AnalysisShell'
import { ComponentAnalysisShell } from './analyses/ComponentAnalysisShell'
import { GenericConfigPanel } from './analyses/GenericConfigPanel'
import { CreateAnalysisDialog } from './CreateAnalysisDialog'
import type { DatasetAnalysis, AnalysisLanguage } from '@/types'
import type { Plugin } from '@/types/plugin'

interface AnalysesPanelProps {
  datasetFileId: string
  hideTabBar?: boolean
}

/**
 * Infer the default language for a legacy analysis that has no `config.language`.
 */
function inferDefaultLanguage(pluginId: string): AnalysisLanguage {
  const plugin = getPlugin(pluginId)
  if (!plugin) return 'python'
  if (plugin.manifest.languages.length > 0) return plugin.manifest.languages[0]
  return 'python'
}

function AnalysisContent({ analysis }: { analysis: DatasetAnalysis }) {
  const plugin = getPlugin(analysis.type)

  // Component mode: plugin has runtime=['component'] and a componentId
  if (plugin?.componentId && plugin.manifest.runtime.includes('component')) {
    return <ComponentAnalysis analysis={analysis} plugin={plugin} />
  }

  // Script mode (python / r): resolve template + AnalysisShell + GenericConfigPanel
  const language = (analysis.config.language as AnalysisLanguage | undefined) ?? inferDefaultLanguage(analysis.type)
  if (plugin && (language === 'python' || language === 'r')) {
    return (
      <ScriptAnalysis
        analysis={analysis}
        language={language}
      />
    )
  }

  // Unknown plugin
  return (
    <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
      Unknown analysis type: {analysis.type}
    </div>
  )
}

/** Wrapper for component-runtime plugins (live React rendering, no script execution). */
function ComponentAnalysis({ analysis, plugin }: { analysis: DatasetAnalysis; plugin: Plugin }) {
  const { files } = useDatasetStore()
  const file = files.find(f => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []
  const schema = plugin.manifest.configSchema

  const renderConfigPanel = (onConfigChange: (changes: Record<string, unknown>) => void) => (
    <GenericConfigPanel
      schema={schema}
      config={analysis.config}
      columns={columns}
      onConfigChange={onConfigChange}
    />
  )

  return (
    <ComponentAnalysisShell
      analysis={analysis}
      configPanel={renderConfigPanel}
      componentId={plugin.componentId!}
    />
  )
}

/** Wrapper that resolves the template and renders AnalysisShell with GenericConfigPanel. */
function ScriptAnalysis({
  analysis,
  language,
}: {
  analysis: DatasetAnalysis
  language: 'python' | 'r'
}) {
  const { t } = useTranslation()
  const { files } = useDatasetStore()

  const plugin = getPlugin(analysis.type)!
  const file = files.find(f => f.id === analysis.datasetFileId)
  const columns = file?.columns ?? []

  const template = plugin.templates?.[language] ?? ''
  const schema = plugin.manifest.configSchema

  const generatedCode = useMemo(
    () => resolveTemplate(template, analysis.config, columns, schema, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [template, JSON.stringify(analysis.config), JSON.stringify(columns.map(c => ({ id: c.id, name: c.name, type: c.type }))), language],
  )

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
        {t('datasets.empty_dataset')}
      </div>
    )
  }

  const renderConfigPanel = (onConfigChange: (changes: Record<string, unknown>) => void) => (
    <GenericConfigPanel
      schema={schema}
      config={analysis.config}
      columns={columns}
      onConfigChange={onConfigChange}
    />
  )

  return (
    <AnalysisShell
      analysis={analysis}
      configPanel={renderConfigPanel}
      generatedCode={generatedCode}
      language={language}
    />
  )
}

export function AnalysesPanel({ datasetFileId, hideTabBar }: AnalysesPanelProps) {
  const { t } = useTranslation()
  const {
    analyses,
    selectedAnalysisId,
  } = useDatasetStore()

  const [createOpen, setCreateOpen] = useState(false)

  const activeAnalysis = analyses.find((a) => a.id === selectedAnalysisId)

  if (analyses.length === 0 && !activeAnalysis) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">{t('datasets.no_analyses')}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} className="mr-1" />
          {t('datasets.new_analysis')}
        </Button>
        <CreateAnalysisDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          datasetFileId={datasetFileId}
        />
      </div>
    )
  }

  // When hideTabBar is true, only render the content (tabs are in the parent)
  if (hideTabBar) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          {activeAnalysis ? (
            <AnalysisContent key={activeAnalysis.id} analysis={activeAnalysis} />
          ) : (
            <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
              {t('datasets.select_analysis')}
            </div>
          )}
        </div>
        <CreateAnalysisDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          datasetFileId={datasetFileId}
        />
      </div>
    )
  }

  // Fallback: render with internal tab bar (not used in current layout)
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {activeAnalysis ? (
          <AnalysisContent key={activeAnalysis.id} analysis={activeAnalysis} />
        ) : (
          <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
            {t('datasets.select_analysis')}
          </div>
        )}
      </div>
      <CreateAnalysisDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        datasetFileId={datasetFileId}
      />
    </div>
  )
}
