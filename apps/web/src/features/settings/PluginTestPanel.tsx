import { useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { PluginOutputRenderer } from '@/features/projects/lab/datasets/analyses/PluginOutputRenderer'
import { resolveTemplate } from '@/lib/plugins/template-resolver'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { PatientChartContext } from '@/features/projects/warehouse/patient-data/PatientChartContext'
import { PatientSummaryWidget } from '@/features/projects/warehouse/patient-data/widgets/PatientSummaryWidget'
import { NotesWidget } from '@/features/projects/warehouse/patient-data/widgets/NotesWidget'
import { PluginConfigPreview } from './PluginConfigPreview'
import type { PluginConfigField } from '@/types/plugin'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'
import type { PatientWidgetType } from '@/stores/patient-chart-store'

/** Synthetic project UID used for system plugin previews. */
const PREVIEW_PROJECT_UID = '__plugin-preview__'

interface PluginTestPanelProps {
  activeTab: 'config' | 'code' | 'results'
  isExecuting: boolean
  result: RuntimeOutput | null
  statusMessage: string | null
  columns: DatasetColumn[]
  installedDeps?: string[]
  onRerun?: () => void
  /** When set, render a live widget preview instead of code output (system plugins). */
  systemWidgetPreview?: PatientWidgetType | null
}

/** Render the appropriate built-in widget component for a preview. */
function renderPreviewWidget(type: PatientWidgetType) {
  switch (type) {
    case 'patient_summary':
      return <PatientSummaryWidget />
    case 'notes':
      return <NotesWidget widgetId="__preview__" />
    default:
      return null
  }
}

/**
 * Wrapper that provides PatientChartContext and syncs patient selection
 * for the preview projectUid.
 */
function SystemWidgetPreviewRenderer({ widgetType }: { widgetType: PatientWidgetType }) {
  const { t } = useTranslation()
  const { testDataSourceId, testPersonId, testVisitId, testVisitDetailId } =
    usePluginEditorStore()
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const { setSelectedPatient, setSelectedVisit, setSelectedVisitDetail } =
    usePatientChartStore()

  const schemaMapping = useMemo(
    () => dataSources.find((ds) => ds.id === testDataSourceId)?.schemaMapping,
    [dataSources, testDataSourceId],
  )

  // Sync test selections into the patient chart store under the preview projectUid
  useEffect(() => {
    setSelectedPatient(PREVIEW_PROJECT_UID, testPersonId)
  }, [testPersonId, setSelectedPatient])

  useEffect(() => {
    setSelectedVisit(PREVIEW_PROJECT_UID, testVisitId)
  }, [testVisitId, setSelectedVisit])

  useEffect(() => {
    setSelectedVisitDetail(PREVIEW_PROJECT_UID, testVisitDetailId)
  }, [testVisitDetailId, setSelectedVisitDetail])

  if (!testDataSourceId) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('plugins.test_select_database')}
      </div>
    )
  }

  return (
    <PatientChartContext.Provider
      value={{
        projectUid: PREVIEW_PROJECT_UID,
        dataSourceId: testDataSourceId ?? undefined,
        schemaMapping,
      }}
    >
      <div className="h-full overflow-auto p-3">
        {renderPreviewWidget(widgetType)}
      </div>
    </PatientChartContext.Provider>
  )
}

export function PluginTestPanel({ activeTab, isExecuting, result, statusMessage, columns, installedDeps, onRerun, systemWidgetPreview }: PluginTestPanelProps) {
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
            {systemWidgetPreview ? (
              <SystemWidgetPreviewRenderer widgetType={systemWidgetPreview} />
            ) : (result || isExecuting) ? (
              <PluginOutputRenderer
                result={result}
                isExecuting={isExecuting}
                statusMessage={statusMessage}
                installedDeps={installedDeps}
                onRerun={onRerun}
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
