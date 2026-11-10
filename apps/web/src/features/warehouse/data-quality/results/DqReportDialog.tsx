import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FieldError } from '@/components/ui/field-error'
import { FormField } from '@/components/ui/form-field'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { downloadBlob } from '@/lib/entity-io'
import { printHtml, rasterizeSvg, reportFileName } from '@/lib/cohort-report/export'
import { shapeDqReportModel } from '@/lib/dq-report/model'
import { renderDqReportHtml } from '@/lib/dq-report/render-html'
import type { DqReport } from '@/lib/duckdb/data-quality-checks'

type ReportFormat = 'html' | 'pdf' | 'docx'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The run reported: the one the Results tab shows. */
  report: DqReport
  title: string
  description?: string
  version?: string
  databaseName: string
}

/**
 * A quality profile's run as a document to hand over: the page itself in a
 * preview, exported as HTML, PDF (the browser's print dialog) or Word.
 */
export function DqReportDialog(props: Props) {
  return props.open ? <ReportPreview {...props} /> : null
}

function ReportPreview({ open, onOpenChange, report, title, description, version, databaseName }: Props) {
  const { t, i18n } = useTranslation()
  const [format, setFormat] = useState<ReportFormat>('html')
  const [includePassed, setIncludePassed] = useState(false)
  const [includeSql, setIncludeSql] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const model = useMemo(() => shapeDqReportModel(report, {
    title, description, version, databaseName, t, locale: i18n.language, includePassed, includeSql,
  }), [report, title, description, version, databaseName, t, i18n.language, includePassed, includeSql])
  const html = useMemo(() => renderDqReportHtml(model, t), [model, t])

  const exportReport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const name = reportFileName(t('dq_report.file_prefix'), model.title, new Date(model.runAt))
      if (format === 'docx') {
        const { renderDqReportDocx } = await import('@/lib/dq-report/render-docx')
        downloadBlob(await renderDqReportDocx(model, t, rasterizeSvg), `${name}.docx`)
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

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      kind="workbench"
      className="sm:max-w-[min(1180px,96vw)]"
      title={t('dq_report.title')}
      description={t('dq_report.description')}
      onConfirm={() => void exportReport()}
      confirmLabel={t('cohort_report.export')}
      confirmDisabled={exporting}
      busy={exporting}
      cancelLabel={t('common.close')}
      noEnterSubmit
      footerExtra={<div className="sm:mr-auto"><FieldError message={exportError} /></div>}
    >
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
          <div className="flex items-center gap-2">
            <Checkbox id="dq-report-passed" checked={includePassed} onCheckedChange={(v) => setIncludePassed(v === true)} />
            <Label htmlFor="dq-report-passed">{t('dq_report.include_passed')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="dq-report-sql" checked={includeSql} onCheckedChange={(v) => setIncludeSql(v === true)} />
            <Label htmlFor="dq-report-sql">{t('cohort_report.include_sql')}</Label>
          </div>
        </div>
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border bg-muted">
          {/* The exported file itself; sandboxed, the report runs no script. */}
          <iframe title={t('dq_report.title')} srcDoc={html} sandbox="" className="h-full w-full border-0" />
        </div>
      </div>
    </DialogShell>
  )
}
