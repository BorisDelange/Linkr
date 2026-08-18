import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Settings, Code2, X, Check, RotateCcw, Copy, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { CustomSqlDot } from '@/components/ui/custom-sql-dot'
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
import { GenericConfigPanel } from '@/features/projects/lab/datasets/analyses/GenericConfigPanel'
import { getPlugin } from '@/lib/plugins/registry'
import { usePatientChartStore } from '@/stores/patient-chart-store'
import { usePatientChartContext } from './PatientChartContext'
import { ConceptPickerDialog } from './ConceptPickerDialog'
import { ConceptSelectField } from './ConceptSelectField'
import { SizedPatientWidgetPreview } from './PatientWidgetPreview'
import { buildWidgetQueries, supportsCustomSql } from './widget-sql'
import { localized } from '@/lib/localized'
import { cn } from '@/lib/utils'
import type { PatientDashboardWidget } from '@/types'
import type { PluginConfigField } from '@/types/plugin'

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

  // Board settings drive the preview geometry, so the preview matches the size the
  // widget actually occupies on this board rather than a generic default.
  const board = usePatientChartStore((s) => {
    const tab = s.tabs.find((tb) => tb.id === widget?.tabId)
    return tab ? s.dashboards.find((d) => d.id === tab.patientDashboardId) : undefined
  })
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

  // A hand-edited SQL would be discarded when the config regenerates the query —
  // but only some settings feed the query at all (styling ones don't), so the
  // warning compares the SQL the new config WOULD generate against the SQL the
  // current one generates. Same guard and wording as the cohort builder,
  // otherwise every appearance tweak would raise a dialog that changes nothing.
  const [overwriteSqlOpen, setOverwriteSqlOpen] = useState(false)
  const pendingConfigRef = useRef<Record<string, unknown> | null>(null)

  const generatedSqlFor = useCallback(
    (config: Record<string, unknown>) =>
      buildWidgetQueries({
        pluginId: widget.pluginId,
        config,
        mapping: schemaMapping,
        patientId,
        visitId,
      })
        .map((q) => q.sql ?? '')
        .join('\n'),
    [widget.pluginId, schemaMapping, patientId, visitId],
  )

  const applyConfigChanges = useCallback(
    (changes: Record<string, unknown>) => {
      const next = { ...draftConfig, ...changes }
      if (draftSql != null && generatedSqlFor(next) !== generatedSqlFor(draftConfig)) {
        pendingConfigRef.current = next
        setOverwriteSqlOpen(true)
        return
      }
      setDraftConfig(next)
    },
    [draftSql, draftConfig, generatedSqlFor],
  )

  const confirmOverwriteSql = useCallback(() => {
    const next = pendingConfigRef.current
    pendingConfigRef.current = null
    setOverwriteSqlOpen(false)
    if (!next) return
    // Dropping the override is the point: the query goes back to being generated.
    setDraftSql(null)
    setDraftConfig(next)
  }, [])

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
      <ConceptSelectField
        field={field}
        conceptCount={conceptIds.length}
        onOpenPicker={() => setConceptPickerOpen(true)}
      />
    ),
    [conceptIds.length],
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
          {editable && draftSql != null && <CustomSqlDot />}
        </Button>
        {activeTab === 'code' && !editable && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {t('patient_data.sql_read_only')}
          </span>
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
                    onConfigChange={applyConfigChanges}
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
                  onSave={handleSave}
                  lang={lang}
                />
              )}
            </div>
          </Allotment.Pane>

          <Allotment.Pane minSize={320}>
            <div className="h-full overflow-hidden border-l">
              <SizedPatientWidgetPreview
                layout={widget.layout}
                widgetSpacing={board?.widgetSpacing}
                fitToHeight={board?.fitToHeight ?? true}
                pluginId={widget.pluginId}
                widgetId={widget.id}
                config={draftConfig}
              />
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
            // Same guard as the config panel: picking concepts changes the query.
            applyConfigChanges(picked)
            setConceptPickerOpen(false)
          }}
        />
      )}

      <AlertDialog
        open={overwriteSqlOpen}
        onOpenChange={(open) => {
          if (!open) pendingConfigRef.current = null
          setOverwriteSqlOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cohorts.sql_overwrite_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cohorts.sql_overwrite_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmOverwriteSql}>
              {t('cohorts.sql_overwrite_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** The Code tab: the generated SQL, editable for the widgets that support it. */
function SqlTab({
  queries,
  editable,
  value,
  onChange,
  onSave,
  lang,
}: {
  queries: ReturnType<typeof buildWidgetQueries>
  editable: boolean
  value: string
  onChange: (sql: string) => void
  /** Monaco swallows Cmd/Ctrl+S, so the window-level handler never sees it while
   *  the editor has focus — it has to be wired through the editor's own command. */
  onSave: () => void
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
        <CodeEditor
          value={value}
          onChange={(v) => onChange(v ?? '')}
          onSave={onSave}
          language="sql"
          height="100%"
        />
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

