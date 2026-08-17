import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Settings, Code2, X, ListChecks, Check, RotateCcw, Copy, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { getPlugin } from '@/lib/plugins/registry'
import { getPatientComponent } from '@/lib/plugins/patient-component-registry'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { buildWidgetQueries, supportsCustomSql } from './widget-sql'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { PatientDashboardWidget } from '@/types'
import type { PluginConfigField } from '@/types/plugin'
import { Suspense } from 'react'

interface PatientWidgetEditorSheetProps {
  widgetId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Editor for a component-runtime patient widget: settings on the left, a live
 * preview of the widget itself on the right — the same shape as the dashboard's
 * WidgetEditorDialog, so the two pages read alike.
 *
 * Like that editor, it never mutates the store until Save: every edit lands in a
 * local draft, and `dirty` drives the Save button. The Code tab shows the SQL the
 * widget runs; for the widgets that support it, that SQL can be overridden.
 */
export function PatientWidgetEditorSheet({
  widgetId,
  open,
  onOpenChange,
}: PatientWidgetEditorSheetProps) {
  const widget = usePatientChartStore((s) =>
    widgetId ? s.widgets.find((w) => w.id === widgetId) : undefined,
  )

  if (!widget) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[calc(100vw-16rem)] max-w-none sm:max-w-none p-0 gap-0"
      >
        {/* Keyed by widget id so switching target resets the draft. */}
        <EditorContent key={widget.id} widget={widget} onClose={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

function EditorContent({
  widget,
  onClose,
}: {
  widget: PatientDashboardWidget
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { schemaMapping, projectUid } = usePatientChartContext()

  const updateWidgetConfig = usePatientChartStore((s) => s.updateWidgetConfig)
  const updateWidgetCustomSql = usePatientChartStore((s) => s.updateWidgetCustomSql)
  const patientId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const visitId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)

  const plugin = getPlugin(widget.pluginId)
  const configSchema = (plugin?.manifest.configSchema ?? {}) as Record<string, PluginConfigField>
  const pluginName = plugin
    ? (plugin.manifest.name?.[lang] ?? plugin.manifest.name?.en ?? plugin.manifest.id)
    : widget.pluginId

  // --- Draft state: nothing reaches the store until Save ---
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>(widget.config ?? {})
  const [draftSql, setDraftSql] = useState<string | null>(widget.customSql ?? null)
  const [conceptPickerOpen, setConceptPickerOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'config' | 'code'>('config')
  const [justSaved, setJustSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dirty =
    JSON.stringify(draftConfig) !== JSON.stringify(widget.config ?? {}) ||
    (draftSql ?? null) !== (widget.customSql ?? null)

  useEffect(() => {
    if (dirty) setJustSaved(false)
  }, [dirty])
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

  const handleSave = useCallback(() => {
    if (!dirty) return
    updateWidgetConfig(widget.id, draftConfig)
    if ((draftSql ?? null) !== (widget.customSql ?? null)) {
      updateWidgetCustomSql(widget.id, draftSql)
    }
    setJustSaved(true)
    savedTimer.current = setTimeout(() => setJustSaved(false), 1500)
  }, [dirty, widget.id, widget.customSql, draftConfig, draftSql, updateWidgetConfig, updateWidgetCustomSql])

  // Cmd/Ctrl+S saves without closing, as in the dashboard editor.
  const saveRef = useRef(handleSave)
  useEffect(() => { saveRef.current = handleSave })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --- SQL ---
  const queries = useMemo(
    () =>
      buildWidgetQueries({
        pluginId: widget.pluginId,
        config: draftConfig,
        mapping: schemaMapping,
        patientId,
        visitId,
      }),
    [widget.pluginId, draftConfig, schemaMapping, patientId, visitId],
  )
  const editable = supportsCustomSql(widget.pluginId)
  const generatedSql = queries[0]?.sql ?? ''

  // An override stops following the config, so the editor shows it verbatim.
  const shownSql = draftSql ?? generatedSql

  const conceptIds = (draftConfig.conceptIds as number[] | undefined) ?? []

  const renderConceptField = useCallback(
    (_fieldKey: string, field: PluginConfigField) => (
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">{field.label[lang as 'en' | 'fr'] ?? field.label.en}</Label>
        {field.description && (
          <p className="text-[11px] text-muted-foreground">
            {field.description[lang as 'en' | 'fr'] ?? field.description.en}
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-full justify-start gap-1.5 text-xs"
          onClick={() => setConceptPickerOpen(true)}
        >
          <ListChecks size={13} />
          {conceptIds.length > 0
            ? t('patient_data.concepts_selected', { count: conceptIds.length })
            : t('patient_data.select_concepts')}
        </Button>
      </div>
    ),
    [conceptIds.length, lang, t],
  )

  const hasConfig = Object.keys(configSchema).length > 0

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="flex-row items-center gap-2 border-b px-3 py-2 space-y-0">
        <SheetTitle className="truncate text-sm">{localized(widget.name, lang)}</SheetTitle>
        <Badge variant="secondary" className="text-[10px]">{pluginName}</Badge>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="xs" disabled={!dirty} onClick={handleSave}>
          {justSaved ? (
            <>
              <Check size={12} />
              {t('common.saved')}
            </>
          ) : (
            t('common.save')
          )}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label={t('common.close')}>
          <X size={14} />
        </Button>
      </SheetHeader>

      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <Button
          variant={activeTab === 'config' ? 'secondary' : 'ghost'}
          size="xs"
          className="gap-1"
          disabled={!hasConfig}
          onClick={() => setActiveTab('config')}
        >
          <Settings size={12} />
          {t('datasets.analysis_config_tab')}
        </Button>
        <Button
          variant={activeTab === 'code' ? 'secondary' : 'ghost'}
          size="xs"
          className="gap-1"
          onClick={() => setActiveTab('code')}
        >
          <Code2 size={12} />
          {t('datasets.analysis_code_tab')}
        </Button>
        {activeTab === 'code' && !editable && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {t('patient_data.sql_read_only')}
          </span>
        )}
        {activeTab === 'code' && editable && draftSql != null && (
          <Badge variant="outline" className="ml-1 text-[10px]">
            {t('cohorts.sql_modified')}
          </Badge>
        )}
        <div className="flex-1" />
        {activeTab === 'code' && editable && draftSql != null && (
          <Button
            variant="ghost"
            size="xs"
            className="gap-1"
            onClick={() => setDraftSql(null)}
          >
            <RotateCcw size={12} />
            {t('cohorts.sql_reset')}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        <Allotment>
          <Allotment.Pane preferredSize="45%" minSize={320}>
            <div className="h-full overflow-auto p-3">
              {activeTab === 'config' ? (
                hasConfig ? (
                  <GenericConfigPanel
                    schema={configSchema}
                    config={draftConfig}
                    columns={[]}
                    onConfigChange={(changes) =>
                      setDraftConfig((prev) => ({ ...prev, ...changes }))
                    }
                    renderConceptField={renderConceptField}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('patient_data.no_settings')}
                  </p>
                )
              ) : (
                <SqlTab
                  queries={queries}
                  editable={editable}
                  value={shownSql}
                  onChange={(v) => setDraftSql(v)}
                  lang={lang}
                />
              )}
            </div>
          </Allotment.Pane>

          <Allotment.Pane minSize={320}>
            <div className="h-full overflow-hidden border-l">
              <WidgetPreview widget={widget} config={draftConfig} />
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      {conceptPickerOpen && (
        <ConceptPickerDialog
          open
          onOpenChange={setConceptPickerOpen}
          config={draftConfig}
          // The settings live in this sheet's Config tab, so the picker opens
          // straight on its concept table with no second settings form.
          initialTab="concepts"
          onConfirm={(picked) => {
            setDraftConfig((prev) => ({ ...prev, ...picked }))
            setConceptPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** The Code tab: the generated SQL, editable for the widgets that support it. */
function SqlTab({
  queries,
  editable,
  value,
  onChange,
  lang,
}: {
  queries: ReturnType<typeof buildWidgetQueries>
  editable: boolean
  value: string
  onChange: (sql: string) => void
  lang: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = (sql: string) => {
    navigator.clipboard.writeText(sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  if (queries.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('patient_data.sql_none')}</p>
  }

  if (editable) {
    const q = queries[0]
    if (!q.sql && q.missing) return <MissingMapping missing={q.missing} />
    return (
      <div className="flex h-full flex-col gap-2">
        <CodeEditor value={value} onChange={(v) => onChange(v ?? '')} language="sql" height="100%" />
      </div>
    )
  }

  // Read-only: one block per query, so a multi-query widget stays legible.
  return (
    <div className="space-y-3">
      {queries.map((q) => (
        <div key={q.id} className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">
              {q.label[lang as 'en' | 'fr'] ?? q.label.en}
            </span>
            <div className="flex-1" />
            {q.sql && (
              <Button variant="ghost" size="icon-xs" onClick={() => copy(q.sql!)}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </Button>
            )}
          </div>
          {q.sql ? (
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-[10px] leading-relaxed">
              {q.sql}
            </pre>
          ) : (
            <MissingMapping missing={q.missing ?? ''} />
          )}
        </div>
      ))}
    </div>
  )
}

/** Why a query could not be built — the point of showing SQL at all for a widget
 *  that renders empty. */
function MissingMapping({ missing }: { missing: string }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-start gap-2 rounded-md border border-dashed p-2')}>
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
      <div className="space-y-0.5">
        <p className="text-xs">{t('patient_data.sql_unavailable')}</p>
        <p className="font-mono text-[10px] text-muted-foreground">{missing}</p>
      </div>
    </div>
  )
}

/** The widget itself, rendered with the draft config so the preview follows edits
 *  before they are saved. */
function WidgetPreview({
  widget,
  config,
}: {
  widget: PatientDashboardWidget
  config: Record<string, unknown>
}) {
  const { projectUid, dataSourceId, schemaMapping } = usePatientChartContext()
  const personId = usePatientChartStore((s) => s.selectedPatientId[projectUid] ?? null)
  const visitOccurrenceId = usePatientChartStore((s) => s.selectedVisitId[projectUid] ?? null)
  const visitDetailId = usePatientChartStore((s) => s.selectedVisitDetailId[projectUid] ?? null)
  const { t } = useTranslation()

  const plugin = getPlugin(widget.pluginId)
  const Component = plugin?.componentId ? getPatientComponent(plugin.componentId) : undefined

  if (!personId) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
        {t('patient_data.select_patient_first')}
      </div>
    )
  }
  if (!Component) return null

  return (
    <Suspense fallback={null}>
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Component
        config={config}
        widgetId={widget.id}
        dataSourceId={dataSourceId}
        schemaMapping={schemaMapping}
        personId={personId}
        visitOccurrenceId={visitOccurrenceId}
        visitDetailId={visitDetailId}
      />
    </Suspense>
  )
}
