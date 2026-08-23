import { describe, it, expect } from 'vitest'
import { parseXlsform, isXlsformWorkbook, type XlsformSheets } from './xlsform-import'
import { questionColumns, questionChoices } from './survey-schema'

// An XLSForm shaped like the MIR questionnaire: groups, a localized label pair,
// select_one / select_multiple, a numeric, branching, an integer-coded scale,
// or_other, and rows that collect no answer (note, calculate, geopoint).
const SHEETS: XlsformSheets = {
  survey: [
    { type: 'begin group', name: 'organisation', 'label::fr': 'Organisation', 'label::en': 'Organisation' },
    { type: 'text', name: 'nom_structure', 'label::fr': "Nom de l'établissement", 'label::en': 'Facility name' },
    { type: 'select_one type_structure', name: 'type_structure', 'label::fr': 'Type de structure', 'label::en': 'Facility type' },
    { type: 'integer', name: 'lits_reanimation', 'label::fr': 'Nombre de lits', 'hint::fr': 'Au 1er janvier' },
    { type: 'select_one oui_non', name: 'zone_dechocage', 'label::fr': 'Zone de déchocage ?' },
    { type: 'integer', name: 'precision_dechocage', 'label::fr': 'Combien de lits ?', relevant: "${zone_dechocage} = 'oui'" },
    { type: 'select_multiple usi', name: 'usi_specialites', 'label::fr': 'Quelles USI ?' },
    { type: 'end group', name: 'organisation' },
    { type: 'select_one satisfaction', name: 'satisfaction', 'label::fr': 'Satisfaction' },
    { type: 'select_multiple activites or_other', name: 'activites_mir', 'label::fr': 'Quelles activités ?' },
    { type: 'note', name: 'merci', 'label::fr': 'Merci !' },
    { type: 'calculate', name: 'total', calculation: '1+1' },
    { type: 'geopoint', name: 'position', 'label::fr': 'Position' },
  ],
  choices: [
    { list_name: 'type_structure', name: 'chu_chr', 'label::fr': 'CHU/CHR', 'label::en': 'University hospital' },
    { list_name: 'type_structure', name: 'ch', 'label::fr': 'Centre Hospitalier', 'label::en': 'General hospital' },
    { list_name: 'oui_non', name: 'oui', 'label::fr': 'Oui' },
    { list_name: 'oui_non', name: 'non', 'label::fr': 'Non' },
    { list_name: 'usi', name: 'usic', 'label::fr': 'USI de Cardiologie' },
    { list_name: 'usi', name: 'usinv', 'label::fr': 'USI Neuro-Vasculaires' },
    { list_name: 'usi', name: 'usih', 'label::fr': "USI d'Hématologie" },
    { list_name: 'satisfaction', name: '1', 'label::fr': 'Pas du tout' },
    { list_name: 'satisfaction', name: '2', 'label::fr': 'Peu' },
    { list_name: 'satisfaction', name: '3', 'label::fr': 'Neutre' },
    { list_name: 'satisfaction', name: '4', 'label::fr': 'Satisfait' },
    { list_name: 'satisfaction', name: '5', 'label::fr': 'Très satisfait' },
    { list_name: 'activites', name: 'avis_urgences', 'label::fr': 'Avis aux urgences' },
    { list_name: 'activites', name: 'don_organes', 'label::fr': "Don d'organes" },
  ],
  settings: [{ form_title: 'Enquête MIR', form_id: 'mir', default_language: 'fr' }],
}

describe('isXlsformWorkbook', () => {
  it('accepts a workbook carrying survey + choices', () => {
    expect(isXlsformWorkbook(['survey', 'choices', 'settings'])).toBe(true)
  })

  it('tolerates case and spacing', () => {
    expect(isXlsformWorkbook([' Survey ', 'CHOICES'])).toBe(true)
  })

  it('rejects an unrelated workbook', () => {
    expect(isXlsformWorkbook(['Sheet1', 'Sheet2'])).toBe(false)
  })
})

describe('parseXlsform', () => {
  const schema = parseXlsform(SHEETS)
  const q = (name: string) => schema.questions.find((x) => x.name === name)

  it('reports xlsform as its source', () => {
    expect(schema.source).toBe('xlsform')
  })

  it('skips rows that collect no answer', () => {
    for (const name of ['merci', 'total', 'position']) expect(q(name)).toBeUndefined()
  })

  it('does not turn group markers into questions', () => {
    expect(schema.questions.some((x) => x.name === 'organisation')).toBe(false)
  })

  it('maps select_one to a single column, keeping its list name', () => {
    const t = q('type_structure')!
    expect(t.kind).toBe('select_one')
    expect(t.listName).toBe('type_structure')
    expect(t.binding).toEqual({ kind: 'single_column', column: 'type_structure' })
  })

  it('reads every language of a label column family', () => {
    expect(q('type_structure')!.label).toEqual({
      fr: 'Type de structure',
      en: 'Facility type',
    })
  })

  it('shares choice lists between questions rather than copying them', () => {
    expect(questionChoices(schema, q('type_structure')!)).toEqual([
      { name: 'chu_chr', label: { fr: 'CHU/CHR', en: 'University hospital' } },
      { name: 'ch', label: { fr: 'Centre Hospitalier', en: 'General hospital' } },
    ])
  })

  it('binds select_multiple to one delimited column, space-separated', () => {
    const usi = q('usi_specialites')!
    expect(usi.kind).toBe('select_multiple')
    expect(usi.binding).toEqual({
      kind: 'delimited',
      column: 'usi_specialites',
      separator: ' ',
      valueKind: 'code',
    })
    expect(questionColumns(usi)).toEqual(['usi_specialites'])
  })

  it('reads an already-expanded export as one-hot instead of delimited', () => {
    const expanded = parseXlsform(SHEETS, [
      'usi_specialites/usic',
      'usi_specialites/usinv',
      'usi_specialites/usih',
    ])
    const usi = expanded.questions.find((x) => x.name === 'usi_specialites')!
    expect(usi.binding.kind).toBe('one_hot')
    expect(questionColumns(usi)).toEqual([
      'usi_specialites/usic',
      'usi_specialites/usinv',
      'usi_specialites/usih',
    ])
  })

  it('assigns the enclosing group as the question section', () => {
    expect(q('type_structure')!.section).toBe('Organisation')
    expect(q('satisfaction')!.section).toBeUndefined()
  })

  it('keeps the relevant expression so a conditional denominator can be flagged', () => {
    expect(q('precision_dechocage')!.relevant).toBe("${zone_dechocage} = 'oui'")
  })

  it('marks consecutive integer codes as ordinal and names as nominal', () => {
    expect(q('satisfaction')!.measure).toBe('ordinal')
    expect(q('type_structure')!.measure).toBe('nominal')
  })

  it('marks a numeric question as continuous', () => {
    expect(q('lits_reanimation')!.kind).toBe('integer')
    expect(q('lits_reanimation')!.measure).toBe('continuous')
  })

  it('records the hint', () => {
    expect(q('lits_reanimation')!.hint).toEqual({ fr: 'Au 1er janvier' })
  })

  it('names the companion question of an or_other select', () => {
    expect(q('activites_mir')!.otherQuestion).toBe('activites_mir_other')
    expect(q('usi_specialites')!.otherQuestion).toBeUndefined()
  })

  it('falls back to the variable name when a question has no label', () => {
    const bare = parseXlsform({
      survey: [{ type: 'text', name: 'sans_libelle' }],
      choices: [],
    })
    expect(bare.questions[0].label).toEqual({ default: 'sans_libelle' })
  })

  it('drops a select whose choice list is missing', () => {
    const orphan = parseXlsform({
      survey: [{ type: 'select_multiple absent', name: 'q1', label: 'Q1' }],
      choices: [],
    })
    expect(orphan.questions).toHaveLength(0)
  })

  it('reads a bare label column under the default language', () => {
    const bare = parseXlsform({
      survey: [{ type: 'text', name: 'q1', label: 'Question 1' }],
      choices: [],
      settings: [{ default_language: 'en' }],
    })
    expect(bare.questions[0].label).toEqual({ en: 'Question 1' })
  })

  it('reads the "French (fr)" long form of a language suffix', () => {
    const long = parseXlsform({
      survey: [{ type: 'text', name: 'q1', 'label::French (fr)': 'Question 1' }],
      choices: [],
    })
    expect(long.questions[0].label).toEqual({ fr: 'Question 1' })
  })
})
