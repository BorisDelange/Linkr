/**
 * Dashboard widget: one questionnaire question.
 *
 * Thin on purpose. All it does is turn a widget config into
 * `SurveyQuestionBlock` props — recovering the questionnaire structure, then
 * resolving the picked column to the question that owns it. The rendering and
 * the statistics live elsewhere, so the Reports page can reuse them without
 * dragging widget config along (see reports-plan.md step 8).
 *
 * Config picks a COLUMN rather than a question, because the config panel's
 * `column-select` field is the shared primitive every plugin uses. For a
 * multiple-choice question, picking any one of its one-hot columns selects the
 * whole question — which is the behaviour a user expects and the reason this
 * indirection is worth it.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList, Loader2 } from 'lucide-react'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns, type SurveyQuestion, type SurveySchema } from '@/lib/survey/survey-schema'
import type { CountSort, QuestionSummary } from '@/lib/survey/survey-analysis'
import { SurveyQuestionBlock, type SurveyQuestionBlockProps } from './SurveyQuestionBlock'
import { availableCharts, type SurveyChart } from './survey-charts'
import { buildSurveyQuestionSpec } from './survey-question-server'

/** The question a column belongs to — the one that lists it among its columns. */
function questionForColumn(schema: SurveySchema, columnId: string): SurveyQuestion | undefined {
  return schema.questions.find((q) => questionColumns(q).includes(columnId))
}

export function SurveyQuestionComponent({
  config,
  columns,
  rows,
  compact,
  datasetFileId,
  datasetFilters,
}: ComponentPluginProps) {
  const { t, i18n } = useTranslation()
  const server = isServerMode()

  // The schema is recovered from the dataset itself. In server mode `rows` is
  // empty, so this runs on the columns alone — which is why the one-hot grouping
  // must not depend on the values (see survey-infer's looksBinary).
  const schema = useMemo(() => inferSurveySchema(columns, rows), [columns, rows])

  const questionColumn = config.questionColumn as string | undefined
  const question = useMemo(
    () => (questionColumn ? questionForColumn(schema, questionColumn) : schema.questions[0]),
    [schema, questionColumn],
  )

  // Server mode: the rows never reach the browser, so the summary is computed by
  // the backend from a validated spec (never client-supplied code — a render is
  // something a plain viewer can trigger).
  const [serverSummary, setServerSummary] = useState<QuestionSummary | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)

  const spec =
    server && datasetFileId && question
      ? buildSurveyQuestionSpec(schema, question, columns, i18n.language)
      : null
  // Stable string keys: the spec is rebuilt every render, so comparing the object
  // itself would refetch forever.
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)

  useEffect(() => {
    if (!server || !datasetFileId || !specKey) return
    let cancelled = false
    renderOnServer('survey-question', JSON.parse(specKey), { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) {
          setServerError(out.stderr)
          return
        }
        try {
          const parsed = JSON.parse(out.stdout.trim()) as QuestionSummary & { error?: string }
          if (parsed.error) {
            setServerError(parsed.error)
            return
          }
          setServerSummary(parsed)
          setServerError(null)
        } catch {
          setServerError(out.stdout || 'Failed to parse result')
        }
      })
      .catch((e) => {
        if (!cancelled) setServerError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (columns.length === 0) {
    return <Placeholder text={t('survey.no_dataset')} />
  }
  if (!question) {
    return <Placeholder text={t('survey.pick_question')} />
  }
  if (server) {
    if (serverError) return <Placeholder text={serverError} />
    if (!serverSummary) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      )
    }
  }

  // A chart that does not apply to this question type falls back to auto rather
  // than rendering something meaningless (a pie of a multiple-choice question).
  const requested = (config.chart as SurveyChart) ?? 'auto'
  const chart = availableCharts(question).includes(requested) ? requested : 'auto'

  const props: SurveyQuestionBlockProps = {
    schema,
    question,
    rows,
    chart,
    sort: (config.sort as CountSort) ?? 'frequency',
    choiceOrder: (config.choiceOrder as string[] | undefined) ?? undefined,
    title: (config.title as string) || undefined,
    showQuestionText: config.showQuestionText !== false,
    showResponseRate: config.showResponseRate !== false,
    valueLabel: (config.valueLabel as SurveyQuestionBlockProps['valueLabel']) ?? 'both',
    hideEmptyChoices: config.hideEmptyChoices === true,
    maxChoices: (config.maxChoices as number) ?? 0,
    color: (config.color as string) ?? 'blue',
    palette: (config.colorPalette as string) ?? 'default',
    bins: (config.bins as number) ?? 0,
    // Percent in the manifest (a slider reads better in whole numbers), 0..1 here.
    opacity: ((config.opacity as number) ?? 70) / 100,
    barSize: (config.barSize as number) ?? 0,
    xLabelMaxLen: (config.xLabelMaxLen as number) ?? 20,
    decimals: (config.decimals as number) ?? 1,
    medianColor: (config.medianColor as string) ?? 'red',
    xAxisStartZero: config.xAxisStartZero === true,
    showMedian: config.showMedian !== false,
    showGrid: config.showGrid !== false,
    compact,
    lang: i18n.language,
    columns,
    // The histogram bins raw values, which server mode has to send along:
    // `rows` is empty there, so without these it would draw an empty chart.
    ...(server && serverSummary
      ? { summary: serverSummary, values: serverSummary.values }
      : {}),
  }

  return <SurveyQuestionBlock {...props} />
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
      <ClipboardList size={20} className="text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  )
}
