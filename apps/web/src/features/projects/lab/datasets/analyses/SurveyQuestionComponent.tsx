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

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { inferSurveySchema } from '@/lib/survey/survey-infer'
import { questionColumns, type SurveyQuestion, type SurveySchema } from '@/lib/survey/survey-schema'
import type { CountSort } from '@/lib/survey/survey-analysis'
import { SurveyQuestionBlock, type SurveyQuestionBlockProps } from './SurveyQuestionBlock'
import { availableCharts, type SurveyChart } from './survey-charts'

/** The question a column belongs to — the one that lists it among its columns. */
function questionForColumn(schema: SurveySchema, columnId: string): SurveyQuestion | undefined {
  return schema.questions.find((q) => questionColumns(q).includes(columnId))
}

export function SurveyQuestionComponent({
  config,
  columns,
  rows,
  compact,
}: ComponentPluginProps) {
  const { t, i18n } = useTranslation()

  // The schema is recovered from the dataset itself. Once the importer persists
  // it to the sidecar, this becomes the fallback rather than the only source.
  const schema = useMemo(() => inferSurveySchema(columns, rows), [columns, rows])

  const questionColumn = config.questionColumn as string | undefined
  const question = useMemo(
    () => (questionColumn ? questionForColumn(schema, questionColumn) : schema.questions[0]),
    [schema, questionColumn],
  )

  if (columns.length === 0) {
    return <Placeholder text={t('survey.no_dataset')} />
  }
  if (!question) {
    return <Placeholder text={t('survey.pick_question')} />
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
    title: (config.title as string) || undefined,
    showQuestionText: config.showQuestionText !== false,
    showResponseRate: config.showResponseRate !== false,
    valueLabel: (config.valueLabel as SurveyQuestionBlockProps['valueLabel']) ?? 'both',
    hideEmptyChoices: config.hideEmptyChoices === true,
    maxChoices: (config.maxChoices as number) ?? 0,
    color: (config.color as string) ?? 'blue',
    palette: (config.colorPalette as string) ?? 'default',
    bins: (config.bins as number) ?? 0,
    showMedian: config.showMedian !== false,
    compact,
    lang: i18n.language,
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
