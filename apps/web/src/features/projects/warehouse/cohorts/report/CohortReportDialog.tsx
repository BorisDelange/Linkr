import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as engine from '@/lib/duckdb/engine'
import { downloadBlob } from '@/lib/entity-io'
import { localized } from '@/lib/localized'
import { printHtml, rasterizeSvg, reportFileName } from '@/lib/cohort-report/export'
import { buildCohortReportModel, CohortReportUnavailable, type CohortReportModel } from '@/lib/cohort-report/model'
import { renderReportHtml } from '@/lib/cohort-report/render-html'
import { DEFAULT_SUPPRESSION_THRESHOLD } from '@/lib/cohort-report/suppress'
import type { Cohort, DataSource } from '@/types'

type ReportFormat = 'html' | 'pdf' | 'docx'

interface CohortReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cohort: Cohort
  /** The database the cohort runs on, connected — undefined otherwise. */
  source: DataSource | undefined
}

/** Why this cohort cannot have a report at all, before anything runs. */
function unavailableReason(cohort: Cohort): string | null {
  if (cohort.customSql) return 'custom-sql'
  if (cohort.level === 'event') return 'event-level'
  return null
}

export function CohortReportDialog(props: CohortReportDialogProps) {
  // Mounted per opening: each one computes the report fresh.
  return props.open ? <ReportPreview {...props} /> : null
}

/** A built report, or why it could not be, for the threshold it was built with. */
type Built = { threshold: number; model: CohortReportModel } | { threshold: number; error: string }

function ReportPreview({ open, onOpenChange, cohort, source }: CohortReportDialogProps) {
  const { t, i18n } = useTranslation()
  const [format, setFormat] = useState<ReportFormat>('html')
  const [threshold, setThreshold] = useState(String(DEFAULT_SUPPRESSION_THRESHOLD))
  const [applied, setApplied] = useState(DEFAULT_SUPPRESSION_THRESHOLD)
  const [includeSql, setIncludeSql] = useState(true)
  const [built, setBuilt] = useState<Built | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const blocked = unavailableReason(cohort)
  const thresholdValue = Number.parseInt(threshold, 10)
  const thresholdValid = Number.isFinite(thresholdValue) && thresholdValue >= 1 && thresholdValue <= 1000
  const loading = !blocked && !!source && (!built || built.threshold !== applied)

  // The suppression is applied in the model, so a new threshold is a new run —
  // asked for with the Recompute button.
  useEffect(() => {
    if (blocked || !source?.schemaMapping) return
    let cancelled = false
    const mapping = source.schemaMapping
    buildCohortReportModel({
      cohort,
      mapping,
      databaseName: localized(source.name, i18n.language),
      databaseVersion: source.version,
      schemaLabel: localized(source.schemaSource?.label, i18n.language)
        || localized(mapping.presetLabel, i18n.language)
        || undefined,
      run: (sql) => engine.queryDataSource(source.id, sql),
      t,
      locale: i18n.language,
      threshold: applied,
    })
      .then((model) => { if (!cancelled) setBuilt({ threshold: applied, model }) })
      .catch((err) => {
        if (cancelled) return
        setBuilt({
          threshold: applied,
          error: err instanceof CohortReportUnavailable
            ? t(`cohort_report.unavailable_${err.reason}`)
            : t('cohort_report.error', { message: err instanceof Error ? err.message : String(err) }),
        })
      })
    return () => { cancelled = true }
    // The cohort as it was when the dialog opened: editing it behind the dialog
    // must not re-run the report mid-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, source?.id])

  const model = built && 'model' in built && built.threshold === applied ? built.model : null
  const html = useMemo(() => (model ? renderReportHtml(model, t, { includeSql }) : null), [model, t, includeSql])
  const buildError = built && 'error' in built && built.threshold === applied ? built.error : null

  const exportReport = async () => {
    if (!model || !html) return
    setExporting(true)
    setExportError(null)
    try {
      const name = reportFileName(t('cohort_report.file_prefix'), model.title, new Date(model.generatedAt))
      if (format === 'docx') {
        const { renderReportDocx } = await import('@/lib/cohort-report/render-docx')
        downloadBlob(await renderReportDocx(model, t, { includeSql }, rasterizeSvg), `${name}.docx`)
      } else if (format === 'pdf') {
        await printHtml(html)
      } else {
        downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${name}.html`)
      }
    } catch (err) {
      setExportError(t('cohort_report.error', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setExporting(false)
    }
  }

  const message = blocked
    ? t(`cohort_report.unavailable_${blocked}`)
    : !source ? t('cohort_report.needs_connection') : null

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      // An A4 page (210 mm, ~800 px) beside the settings column, without a
      // horizontal scroll in the preview.
      className="sm:max-w-[min(1180px,96vw)]"
      title={t('cohort_report.title')}
      description={t('cohort_report.description')}
      onConfirm={() => void exportReport()}
      confirmLabel={t('cohort_report.export')}
      confirmDisabled={!html || exporting}
      busy={exporting}
      cancelLabel={t('common.close')}
      noEnterSubmit
      footerExtra={
        <div className="flex items-center gap-2 sm:mr-auto">
          {/* The threshold is applied in the model, so a new one is a new run —
              asked for here, not on every keystroke (some thirty queries). */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!thresholdValid || thresholdValue === applied || loading || !!message}
            onClick={() => setApplied(thresholdValue)}
          >
            <RefreshCw size={14} />
            {t('cohort_report.recompute')}
          </Button>
          <FieldError message={exportError} />
        </div>
      }
    >
      {message ? (
        <p className="p-4 text-sm text-muted-foreground">{message}</p>
      ) : (
        <div className="flex h-full min-h-0 gap-4">
          <div className="w-56 shrink-0 space-y-4">
            <FormField label={t('cohort_report.format')}>
              {({ id }) => (
                <Select value={format} onValueChange={(v) => setFormat(v as ReportFormat)}>
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="html">{t('cohort_report.format_html')}</SelectItem>
                    <SelectItem value="pdf">{t('cohort_report.format_pdf')}</SelectItem>
                    <SelectItem value="docx">{t('cohort_report.format_docx')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField label={t('cohort_report.threshold')} hint={t('cohort_report.threshold_hint')} hintInTooltip>
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={1000}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && thresholdValid) setApplied(thresholdValue) }}
                />
              )}
            </FormField>
            <div className="flex items-center gap-2">
              <Checkbox id="cohort-report-sql" checked={includeSql} onCheckedChange={(v) => setIncludeSql(v === true)} />
              <Label htmlFor="cohort-report-sql">{t('cohort_report.include_sql')}</Label>
            </div>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border bg-muted">
            {html && (
              // The exported file itself, not a re-rendering of it: what is read
              // here is what is sent. Sandboxed — the report runs no script.
              <iframe title={t('cohort_report.title')} srcDoc={html} sandbox="" className="h-full w-full border-0" />
            )}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                {t('cohort_report.generating')}
              </div>
            )}
            {buildError && (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                <FieldError message={buildError} />
              </div>
            )}
          </div>
        </div>
      )}
    </DialogShell>
  )
}
