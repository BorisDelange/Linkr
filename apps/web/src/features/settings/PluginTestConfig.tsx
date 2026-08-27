import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePluginEditorStore } from '@/stores/plugin-editor-store'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { getStorage } from '@/lib/storage'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildPatientListQuery,
  buildVisitListQuery,
  buildVisitDetailListQuery,
} from '@/lib/duckdb/patient-data-queries'
import { localized } from '@/lib/localized'

interface PluginTestConfigProps {
  /** Plugin scope — lab tests against a project dataset, warehouse against a database. */
  scope?: 'lab' | 'warehouse'
  /** Languages declared in the plugin manifest — constrains the language selector. */
  manifestLanguages?: ('python' | 'r')[]
  /** System plugins can be run but not re-configured, so the language picker hides. */
  readOnly?: boolean
}

/**
 * Picks what a test run executes against. It sits beside Run in the toolbar
 * because it is the input to that button, not a property of the file list it
 * used to live in.
 */
export function PluginTestConfig({ scope = 'lab', manifestLanguages, readOnly }: PluginTestConfigProps) {
  const { t, i18n } = useTranslation()
  const projects = useAppStore((s) => s.projects)
  const dataSources = useDataSourceStore((s) => s.dataSources)
  const ensureMounted = useDataSourceStore((s) => s.ensureMounted)
  const {
    testLanguage,
    testProjectUid,
    testDatasetFileId,
    testDataSourceId,
    testPersonId,
    testVisitId,
    testVisitDetailId,
    setTestLanguage,
    setTestProject,
    setTestDataset,
    setTestDataSource,
    setTestPersonId,
    setTestVisitId,
    setTestVisitDetailId,
  } = usePluginEditorStore()

  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([])
  const [patients, setPatients] = useState<{ id: string; label: string }[]>([])
  const [visits, setVisits] = useState<{ id: string; label: string }[]>([])
  const [visitDetails, setVisitDetails] = useState<{ id: string; label: string }[]>([])

  const availableLanguages = useMemo(
    () => (manifestLanguages?.length ? manifestLanguages : (['python', 'r'] as ('python' | 'r')[])),
    [manifestLanguages],
  )

  // Vocabulary references have no patients, and without a schema mapping there
  // is nothing to address the patient tables by.
  const connectedSources = useMemo(
    () =>
      dataSources.filter(
        (ds) => ds.status === 'connected' && !ds.isVocabularyReference && !!ds.schemaMapping?.patientTable,
      ),
    [dataSources],
  )

  const selectedSourceMapping = useMemo(
    () => dataSources.find((ds) => ds.id === testDataSourceId)?.schemaMapping,
    [dataSources, testDataSourceId],
  )

  const loadDatasets = useCallback(async (uid: string) => {
    try {
      const dsFiles = await getStorage().datasetFiles.getByProject(uid)
      setDatasets(
        dsFiles
          .filter((f) => f.type === 'file' && f.columns && f.columns.length > 0)
          .map((f) => ({ id: f.id, name: f.name })),
      )
    } catch {
      setDatasets([])
    }
  }, [])

  const handleProjectChange = useCallback(
    async (uid: string) => {
      setTestProject(uid)
      await loadDatasets(uid)
    },
    [setTestProject, loadDatasets],
  )

  useEffect(() => {
    if (testProjectUid) loadDatasets(testProjectUid)
  }, [testProjectUid, loadDatasets])

  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping) {
      setPatients([])
      return
    }
    let cancelled = false
    const sql = buildPatientListQuery(selectedSourceMapping, null, 200, 0)
    if (!sql) { setPatients([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setPatients(rows.map((r) => ({ id: String(r.patient_id), label: String(r.patient_id) })))
        }
      })
      .catch(() => { if (!cancelled) setPatients([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, ensureMounted])

  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping || !testPersonId) {
      setVisits([])
      return
    }
    let cancelled = false
    const sql = buildVisitListQuery(selectedSourceMapping, testPersonId)
    if (!sql) { setVisits([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setVisits(rows.map((r) => {
            const id = String(r.visit_id)
            const date = r.start_date ? ` (${String(r.start_date).slice(0, 10)})` : ''
            return { id, label: `${id}${date}` }
          }))
        }
      })
      .catch(() => { if (!cancelled) setVisits([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, testPersonId, ensureMounted])

  useEffect(() => {
    if (!testDataSourceId || !selectedSourceMapping || !testVisitId) {
      setVisitDetails([])
      return
    }
    let cancelled = false
    const sql = buildVisitDetailListQuery(selectedSourceMapping, testVisitId)
    if (!sql) { setVisitDetails([]); return }
    ensureMounted(testDataSourceId)
      .then(() => queryDataSource(testDataSourceId, sql))
      .then((rows) => {
        if (!cancelled) {
          setVisitDetails(rows.map((r) => {
            const id = String(r.visit_detail_id)
            const unit = r.unit ? ` – ${String(r.unit)}` : ''
            const date = r.start_date ? ` (${String(r.start_date).slice(0, 10)})` : ''
            return { id, label: `${id}${unit}${date}` }
          }))
        }
      })
      .catch(() => { if (!cancelled) setVisitDetails([]) })
    return () => { cancelled = true }
  }, [testDataSourceId, selectedSourceMapping, testVisitId, ensureMounted])

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* Outline, not the filled Run style: it configures the run rather
                than being the action itself. */}
            <Button variant="outline" size="xs" className="gap-1">
              <Settings2 size={12} />
              {t('plugins.test_config')}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('plugins.test_config')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-[260px] space-y-3">
        <Label>{t('plugins.test_config')}</Label>

        {scope === 'lab' && (
          <>
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t('plugins.test_select_project')}</Label>
              <Select value={testProjectUid ?? ''} onValueChange={handleProjectChange}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={t('plugins.test_select_project')} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.uid} value={p.uid}>
                      {p.name || p.uid}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {testProjectUid && (
              <div className="space-y-1">
                <Label className="text-muted-foreground">{t('plugins.test_select_dataset')}</Label>
                <Select value={testDatasetFileId ?? ''} onValueChange={setTestDataset}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder={t('plugins.test_select_dataset')} />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}

        {scope === 'warehouse' && (
          <>
            <div className="space-y-1">
              <Label className="text-muted-foreground">{t('plugins.test_select_database')}</Label>
              <Select value={testDataSourceId ?? ''} onValueChange={setTestDataSource}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue placeholder={t('plugins.test_select_database')} />
                </SelectTrigger>
                <SelectContent>
                  {connectedSources.map((ds) => (
                    <SelectItem key={ds.id} value={ds.id}>
                      {localized(ds.name, i18n.language) || ds.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {patients.length > 0 && (
              <div className="space-y-1">
                <Label className="text-muted-foreground">{t('plugins.test_patient')}</Label>
                <Select value={testPersonId ?? ''} onValueChange={setTestPersonId}>
                  <SelectTrigger className="h-8 w-full font-mono text-xs">
                    <SelectValue placeholder={t('plugins.test_patient')} />
                  </SelectTrigger>
                  <SelectContent>
                    {patients.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="font-mono">
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {testPersonId && visits.length > 0 && (
              <div className="space-y-1">
                <Label className="text-muted-foreground">{t('plugins.test_hospitalization')}</Label>
                <Select value={testVisitId ?? ''} onValueChange={setTestVisitId}>
                  <SelectTrigger className="h-8 w-full font-mono text-xs">
                    <SelectValue placeholder={t('common.optional')} />
                  </SelectTrigger>
                  <SelectContent>
                    {visits.map((v) => (
                      <SelectItem key={v.id} value={v.id} className="font-mono">
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {testVisitId && visitDetails.length > 0 && (
              <div className="space-y-1">
                <Label className="text-muted-foreground">{t('plugins.test_unit_stay')}</Label>
                <Select value={testVisitDetailId ?? ''} onValueChange={setTestVisitDetailId}>
                  <SelectTrigger className="h-8 w-full font-mono text-xs">
                    <SelectValue placeholder={t('common.optional')} />
                  </SelectTrigger>
                  <SelectContent>
                    {visitDetails.map((vd) => (
                      <SelectItem key={vd.id} value={vd.id} className="font-mono">
                        {vd.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}

        {!readOnly && (
          <div className="space-y-1">
            <Label className="text-muted-foreground">{t('plugins.test_language')}</Label>
            <Select value={testLanguage} onValueChange={(v) => setTestLanguage(v as 'python' | 'r')}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableLanguages.includes('python') && (
                  <SelectItem value="python">Python</SelectItem>
                )}
                {availableLanguages.includes('r') && (
                  <SelectItem value="r">R</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
