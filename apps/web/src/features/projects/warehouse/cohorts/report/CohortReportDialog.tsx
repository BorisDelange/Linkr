import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
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
import { buildCohortReportModel, CohortReportUnavailable } from '@/lib/cohort-report/model'
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

export function CohortReportDialog({ open, onOpenChange, cohort, source }: CohortReportDialogProps) {
  const { t, i18n } = useTranslation()
  const [format, setFormat] = useState<ReportFormat>('html')
  const [threshold, setThreshold] = useState(String(DEFAULT_SUPPRESSION_THRESHOLD))
  const [includeSql, setIncludeSql] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blocked = unavailableReason(cohort)
  const thresholdValue = Number.parseInt(threshold, 10)
  const thresholdValid = Number.isFinite(thresholdValue) && thresholdValue >= 1 && thresholdValue <= 1000

  const generate = async () => {
    if (!source?.schemaMapping || !thresholdValid) return
    setBusy(true)
    setError(null)
    try {
      const model = await buildCohortReportModel({
        cohort,
        mapping: source.schemaMapping,
        databaseName: localized(source.name, i18n.language),
        run: (sql) => engine.queryDataSource(source.id, sql),
        t,
        locale: i18n.language,
        threshold: thresholdValue,
      })
      const name = reportFileName(t('cohort_report.file_prefix'), model.title, new Date(model.generatedAt))
      const opts = { includeSql }
      if (format === 'docx') {
        const { renderReportDocx } = await import('@/lib/cohort-report/render-docx')
        downloadBlob(await renderReportDocx(model, t, opts, rasterizeSvg), `${name}.docx`)
      } else {
        const html = renderReportHtml(model, t, opts)
        if (format === 'pdf') await printHtml(html)
        else downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${name}.html`)
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof CohortReportUnavailable
        ? t(`cohort_report.unavailable_${err.reason}`)
        : t('cohort_report.error', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('cohort_report.title')}
      description={t('cohort_report.description')}
      onConfirm={() => void generate()}
      confirmLabel={t('cohort_report.generate')}
      confirmDisabled={!!blocked || !source || !thresholdValid}
      busy={busy}
      footerExtra={
        <span className="flex items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
          {busy && (
            <>
              <Loader2 size={13} className="shrink-0 animate-spin" />
              {t('cohort_report.generating')}
            </>
          )}
        </span>
      }
    >
      {blocked ? (
        <p className="text-sm text-muted-foreground">{t(`cohort_report.unavailable_${blocked}`)}</p>
      ) : !source ? (
        <p className="text-sm text-muted-foreground">{t('cohort_report.needs_connection')}</p>
      ) : (
        <>
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
          <FormField label={t('cohort_report.threshold')} hint={t('cohort_report.threshold_hint')}>
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={1000}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="w-28"
              />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Checkbox id="cohort-report-sql" checked={includeSql} onCheckedChange={(v) => setIncludeSql(v === true)} />
            <Label htmlFor="cohort-report-sql">{t('cohort_report.include_sql')}</Label>
          </div>
        </>
      )}
      <FieldError message={error} />
    </DialogShell>
  )
}
