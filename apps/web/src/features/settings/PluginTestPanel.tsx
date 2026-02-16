import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { AnalysisOutputRenderer } from '@/features/projects/lab/datasets/analyses/AnalysisOutputRenderer'
import { executeAnalysisCode, executeAnalysisCodeR } from '@/features/projects/lab/datasets/analysis-executor'
import { resolveTemplate } from '@/lib/analysis-plugins/template-resolver'
import { useAppStore } from '@/stores/app-store'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { getStorage } from '@/lib/storage'
import { PluginConfigPreview } from './PluginConfigPreview'
import type { PluginConfigField } from '@/types/analysis-plugin'
import type { RuntimeOutput } from '@/lib/runtimes/types'
import type { DatasetColumn } from '@/types'

export function PluginTestPanel() {
  const { t } = useTranslation()
  const projects = useAppStore((s) => s.projects)
  const {
    files,
    testLanguage,
    testProjectUid,
    testDatasetFileId,
    testConfig,
    setTestLanguage,
    setTestProject,
    setTestDataset,
  } = usePluginEditorStore()

  const [previewTab, setPreviewTab] = useState<'config' | 'test'>('config')
  const [datasets, setDatasets] = useState<{ id: string; name: string; columns: DatasetColumn[] }[]>([])
  const [isExecuting, setIsExecuting] = useState(false)
  const [result, setResult] = useState<RuntimeOutput | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  // Load datasets when project changes
  const handleProjectChange = useCallback(async (uid: string) => {
    setTestProject(uid)
    try {
      const storage = getStorage()
      const dsFiles = await storage.datasetFiles.getByProject(uid)
      const fileDatasets = dsFiles
        .filter((f) => f.type === 'file' && f.columns && f.columns.length > 0)
        .map((f) => ({ id: f.id, name: f.name, columns: f.columns! }))
      setDatasets(fileDatasets)
    } catch {
      setDatasets([])
    }
  }, [setTestProject])

  const selectedDataset = datasets.find((d) => d.id === testDatasetFileId)
  const columns = selectedDataset?.columns ?? []

  const parsedSchema = useMemo(() => {
    try {
      const manifest = JSON.parse(files['plugin.json'] ?? '{}')
      return (manifest.configSchema ?? {}) as Record<string, PluginConfigField>
    } catch { return {} }
  }, [files])

  const handleRun = useCallback(async () => {
    if (!testDatasetFileId) return
    setIsExecuting(true)
    setResult(null)
    setStatusMessage(null)
    try {
      // Load dataset rows
      const storage = getStorage()
      const datasetData = await storage.datasetData.get(testDatasetFileId)
      const rows = datasetData?.rows ?? []

      // Find template for selected language
      let template = ''
      for (const [filename, content] of Object.entries(files)) {
        if (testLanguage === 'python' && filename.endsWith('.py.template')) { template = content; break }
        if (testLanguage === 'r' && filename.endsWith('.R.template')) { template = content; break }
      }

      // Resolve template
      const code = resolveTemplate(template, testConfig, columns, parsedSchema, testLanguage)

      // Execute
      const exec = testLanguage === 'r' ? executeAnalysisCodeR : executeAnalysisCode
      const output = await exec(code, rows, columns)
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
      setIsExecuting(false)
      setStatusMessage(null)
    }
  }, [testDatasetFileId, testLanguage, files, testConfig, columns, parsedSchema])

  return (
    <div className="flex h-full flex-col">
      {/* Sub-tabs: Config / Test */}
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <button
          type="button"
          onClick={() => setPreviewTab('config')}
          className={`rounded px-2 py-1 text-xs transition-colors ${previewTab === 'config' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
        >
          {t('plugins.config_preview')}
        </button>
        <button
          type="button"
          onClick={() => setPreviewTab('test')}
          className={`rounded px-2 py-1 text-xs transition-colors ${previewTab === 'test' ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-accent/50'}`}
        >
          {t('plugins.test')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {previewTab === 'config' ? (
          <PluginConfigPreview columns={columns.length > 0 ? columns : undefined} />
        ) : (
          <div className="space-y-3 p-3">
            {/* Project selector */}
            <div className="space-y-1">
              <Label className="text-xs">{t('plugins.test_select_project')}</Label>
              <Select value={testProjectUid ?? ''} onValueChange={handleProjectChange}>
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder={t('plugins.test_select_project')} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.uid} value={p.uid} className="text-xs">
                      {p.name?.en ?? p.name?.fr ?? p.uid}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Dataset selector */}
            {testProjectUid && (
              <div className="space-y-1">
                <Label className="text-xs">{t('plugins.test_select_dataset')}</Label>
                <Select value={testDatasetFileId ?? ''} onValueChange={setTestDataset}>
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder={t('plugins.test_select_dataset')} />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((d) => (
                      <SelectItem key={d.id} value={d.id} className="text-xs">
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Language + Run */}
            <div className="flex items-center gap-2">
              <Select value={testLanguage} onValueChange={(v) => setTestLanguage(v as 'python' | 'r')}>
                <SelectTrigger className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="python" className="text-xs">Python</SelectItem>
                  <SelectItem value="r" className="text-xs">R</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleRun}
                disabled={isExecuting || !testDatasetFileId}
              >
                <Play size={12} />
                {t('plugins.test_run')}
              </Button>
            </div>

            {/* Output */}
            {(result || isExecuting) && (
              <div className="rounded-md border">
                <AnalysisOutputRenderer
                  result={result}
                  isExecuting={isExecuting}
                  statusMessage={statusMessage}
                />
              </div>
            )}

            {!testDatasetFileId && testProjectUid && datasets.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('plugins.test_no_dataset')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
