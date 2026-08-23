import { describe, it, expect } from 'vitest'
import { SURVEY_PRESETS, findPreset, presetsForFile, suggestPreset } from './survey-presets'

describe('SURVEY_PRESETS', () => {
  it('offers the plain table first, so a questionnaire preset is always deliberate', () => {
    expect(SURVEY_PRESETS[0].id).toBe('none')
  })

  it('declares the companion file the two-file presets need', () => {
    expect(findPreset('redcap')!.requires).toBeDefined()
    expect(findPreset('xlsform')!.requires).toBeDefined()
    expect(findPreset('goupile')!.requires).toBeUndefined()
  })
})

describe('presetsForFile', () => {
  it('offers the Excel-only presets for a workbook', () => {
    const ids = presetsForFile('export.xlsx').map((p) => p.id)
    expect(ids).toContain('goupile')
    expect(ids).toContain('xlsform')
  })

  it('does not offer a Goupile import for a CSV', () => {
    const ids = presetsForFile('data.csv').map((p) => p.id)
    expect(ids).not.toContain('goupile')
    expect(ids).toContain('redcap')
  })

  it('always keeps the plain table available', () => {
    expect(presetsForFile('weird.parquet').map((p) => p.id)).toContain('none')
  })

  it('is case-insensitive about the extension', () => {
    expect(presetsForFile('EXPORT.XLSX').map((p) => p.id)).toContain('goupile')
  })
})

describe('suggestPreset', () => {
  it('recognises a Goupile workbook by its dictionary sheets', () => {
    expect(suggestPreset(['introduction', '@definitions', '@propositions'], [])).toBe('goupile')
  })

  it('recognises an XLSForm workbook by its survey + choices sheets', () => {
    expect(suggestPreset(['survey', 'choices', 'settings'], [])).toBe('xlsform')
  })

  it('recognises a REDCap dictionary by its headers', () => {
    expect(suggestPreset([], ['Variable / Field Name', 'Form Name', 'Field Type'])).toBe('redcap')
  })

  it('suggests nothing for an ordinary table', () => {
    expect(suggestPreset(['Sheet1'], ['hopital', 'service'])).toBe('none')
  })

  it('prefers Goupile when a workbook somehow matches both', () => {
    expect(suggestPreset(['@definitions', '@propositions', 'survey', 'choices'], [])).toBe('goupile')
  })
})
