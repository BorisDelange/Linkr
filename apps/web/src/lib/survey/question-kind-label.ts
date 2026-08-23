import type { TFunction } from 'i18next'
import type { SurveyQuestion } from './survey-schema'

/**
 * How the question was asked, in words.
 *
 * Shared by the widget (which states it under the response bar) and the config
 * panel's question picker, so a question is described the same way wherever it
 * is named. The reader needs this BEFORE the numbers: a multiple-choice
 * question's percentages legitimately sum past 100%, which is only sensible if
 * you already know several answers were allowed.
 *
 * There is deliberately no "binary" kind. A yes/no question is a `select_one`
 * with two options — it is counted, sorted and drawn exactly like any other
 * single choice, so a separate kind would duplicate the logic and change no
 * result. The distinction that does change behaviour is `measure`: an `ordinal`
 * scale keeps the questionnaire's order, where a `nominal` list is free to sort
 * by frequency.
 */
export function questionKindLabel(question: SurveyQuestion, t: TFunction): string {
  switch (question.kind) {
    case 'select_one':
      return question.measure === 'ordinal' ? t('survey.kind_scale') : t('survey.kind_single')
    case 'select_multiple':
      return t('survey.kind_multiple')
    case 'integer':
    case 'decimal':
    case 'range':
      return t('survey.kind_numeric')
    case 'date':
    case 'datetime':
      return t('survey.kind_date')
    default:
      return t('survey.kind_text')
  }
}
