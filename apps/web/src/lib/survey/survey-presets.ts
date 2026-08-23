/**
 * The import presets the upload dialog offers, and what each one needs.
 *
 * The dialog picks a preset from a dropdown rather than sniffing the file:
 * detection is a *suggestion* that preselects an entry, never a silent decision.
 * Auto-detection was how Goupile worked at first, and it is the wrong default —
 * a questionnaire import that guesses wrong fails in ways that only surface much
 * later, in a chart nobody can explain.
 *
 * A preset is metadata only: which files it needs, how to recognise a likely
 * match, and what it is called. The parsing lives in the `*-import` modules.
 */

import type { SurveySource } from './survey-schema'

/** What a preset needs beyond the data file itself. */
export interface PresetRequirement {
  /** i18n key for the extra file's label (e.g. the REDCap data dictionary). */
  labelKey: string
  /** Accepted extensions for the file picker. */
  accept: string
}

export interface SurveyPreset {
  id: SurveySource | 'none'
  /** i18n key for the dropdown entry. */
  labelKey: string
  /** i18n key for the one-line explanation under the dropdown. */
  hintKey: string
  /** Extensions the data file may have. */
  accept: string[]
  /** A second file the preset cannot work without (REDCap ships its dictionary
   *  separately; XLSForm ships the form separately from the responses). */
  requires?: PresetRequirement
}

/**
 * `none` first: the ordinary "just import this table" path stays the default,
 * so a questionnaire preset is always a deliberate choice.
 */
export const SURVEY_PRESETS: SurveyPreset[] = [
  {
    id: 'none',
    labelKey: 'datasets.preset_none',
    hintKey: 'datasets.preset_none_hint',
    accept: ['.csv', '.tsv', '.txt', '.xlsx', '.xls', '.parquet'],
  },
  {
    id: 'goupile',
    labelKey: 'datasets.preset_goupile',
    hintKey: 'datasets.preset_goupile_hint',
    accept: ['.xlsx', '.xls'],
  },
  {
    id: 'redcap',
    labelKey: 'datasets.preset_redcap',
    hintKey: 'datasets.preset_redcap_hint',
    accept: ['.csv'],
    requires: { labelKey: 'datasets.preset_redcap_dictionary', accept: '.csv' },
  },
  {
    id: 'xlsform',
    labelKey: 'datasets.preset_xlsform',
    hintKey: 'datasets.preset_xlsform_hint',
    accept: ['.csv', '.xlsx', '.xls'],
    requires: { labelKey: 'datasets.preset_xlsform_form', accept: '.xlsx,.xls' },
  },
]

export function findPreset(id: string): SurveyPreset | undefined {
  return SURVEY_PRESETS.find((p) => p.id === id)
}

/** Presets that can read a file with this extension, `none` always included. */
export function presetsForFile(fileName: string): SurveyPreset[] {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return SURVEY_PRESETS.filter((p) => p.id === 'none' || p.accept.includes(ext))
}

/**
 * The preset a file most likely needs, or `none`.
 *
 * Only ever used to preselect the dropdown — the user always sees, and can
 * change, what will actually run.
 *
 * @param sheetNames  workbook sheet names, for the formats that live in Excel
 * @param headers     the first row's headers, for CSV formats
 */
export function suggestPreset(sheetNames: string[], headers: string[]): SurveySource | 'none' {
  if (sheetNames.includes('@definitions') && sheetNames.includes('@propositions')) return 'goupile'
  const lowerSheets = sheetNames.map((n) => n.trim().toLowerCase())
  if (lowerSheets.includes('survey') && lowerSheets.includes('choices')) return 'xlsform'
  const lowerHeaders = new Set(headers.map((h) => h.trim().toLowerCase()))
  if (lowerHeaders.has('variable / field name') && lowerHeaders.has('field type')) return 'redcap'
  return 'none'
}
