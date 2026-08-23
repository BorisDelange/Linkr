import { describe, it, expect } from 'vitest'
import {
  parseRedcapChoices,
  parseRedcapDictionary,
  redcapChoiceSlug,
  isRedcapDictionary,
  isRedcapSystemColumn,
  type RedcapDictionaryRows,
} from './redcap-import'
import { questionColumns, questionChoices } from './survey-schema'

// A dictionary shaped like a real REDCap export, exercising every field type we
// map: text id, radio, dropdown, numeric-by-validation, yesno, checkbox, notes,
// an integer-coded Likert, and a descriptive field that is not a question.
const DICT: RedcapDictionaryRows = [
  { 'Variable / Field Name': 'record_id', 'Form Name': 'introduction', 'Field Type': 'text', 'Field Label': 'Identifiant' },
  {
    'Variable / Field Name': 'type_structure', 'Form Name': 'organisation', 'Section Header': 'Votre établissement',
    'Field Type': 'radio', 'Field Label': 'Type de structure',
    'Choices, Calculations, OR Slider Labels': 'chu_chr, CHU/CHR | ch, Centre Hospitalier | autre, Autre',
  },
  {
    'Variable / Field Name': 'lits_reanimation', 'Form Name': 'organisation', 'Field Type': 'text',
    'Field Label': 'Nombre de lits', 'Text Validation Type OR Show Slider Number': 'integer',
  },
  {
    'Variable / Field Name': 'zone_dechocage', 'Form Name': 'organisation', 'Field Type': 'yesno',
    'Field Label': 'Zone de déchocage ?',
  },
  {
    'Variable / Field Name': 'precision_dechocage', 'Form Name': 'organisation', 'Field Type': 'text',
    'Field Label': 'Combien de lits ?', 'Text Validation Type OR Show Slider Number': 'integer',
    'Branching Logic (Show field only if...)': "[zone_dechocage] = '1'",
  },
  {
    'Variable / Field Name': 'usi_specialites', 'Form Name': 'organisation', 'Field Type': 'checkbox',
    'Field Label': 'Quelles USI ?',
    'Choices, Calculations, OR Slider Labels': 'usic, USI de Cardiologie | usinv, USI Neuro-Vasculaires | autres, Autres',
  },
  {
    'Variable / Field Name': 'satisfaction', 'Form Name': 'equipe', 'Field Type': 'radio',
    'Field Label': 'Satisfaction',
    'Choices, Calculations, OR Slider Labels': '1, Pas du tout | 2, Peu | 3, Neutre | 4, Satisfait | 5, Très satisfait',
  },
  { 'Variable / Field Name': 'remarques', 'Form Name': 'fin', 'Field Type': 'notes', 'Field Label': 'Remarques' },
  { 'Variable / Field Name': 'banniere', 'Form Name': 'fin', 'Field Type': 'descriptive', 'Field Label': 'Merci !' },
]

const DATA_COLUMNS = [
  'record_id', 'type_structure', 'lits_reanimation', 'zone_dechocage', 'precision_dechocage',
  'usi_specialites___usic', 'usi_specialites___usinv', 'usi_specialites___autres',
  'satisfaction', 'remarques', 'organisation_complete',
]

describe('parseRedcapChoices', () => {
  it('splits code/label pairs on the pipe', () => {
    expect(parseRedcapChoices('a, Alpha | b, Beta')).toEqual([
      { name: 'a', label: { en: 'Alpha' } },
      { name: 'b', label: { en: 'Beta' } },
    ])
  })

  it('splits on the FIRST comma only, so labels may contain commas', () => {
    expect(parseRedcapChoices('chu_chr, CHU, CHR ou assimilé')).toEqual([
      { name: 'chu_chr', label: { en: 'CHU, CHR ou assimilé' } },
    ])
  })

  it('falls back to the code as its own label when there is no comma', () => {
    expect(parseRedcapChoices('oui | non')).toEqual([
      { name: 'oui', label: { en: 'oui' } },
      { name: 'non', label: { en: 'non' } },
    ])
  })

  it('ignores empty segments and trailing pipes', () => {
    expect(parseRedcapChoices('a, Alpha | | b, Beta |')).toHaveLength(2)
  })

  it('returns nothing for an empty cell', () => {
    expect(parseRedcapChoices('')).toEqual([])
  })
})

describe('redcapChoiceSlug', () => {
  it('lowercases and collapses non-alphanumerics into single underscores', () => {
    expect(redcapChoiceSlug('Hepato-Gastro')).toBe('hepato_gastro')
    expect(redcapChoiceSlug('A B  C')).toBe('a_b_c')
  })

  it('turns a leading minus into an underscore rather than dropping it', () => {
    expect(redcapChoiceSlug('-1')).toBe('_1')
  })
})

describe('isRedcapDictionary', () => {
  it('accepts a header row carrying field name + field type', () => {
    expect(isRedcapDictionary(['Variable / Field Name', 'Form Name', 'Field Type'])).toBe(true)
  })

  it('tolerates case and spacing differences', () => {
    expect(isRedcapDictionary(['variable / field name', 'FIELD TYPE'])).toBe(true)
  })

  it('rejects an unrelated CSV', () => {
    expect(isRedcapDictionary(['hopital', 'service', 'email'])).toBe(false)
  })
})

describe('parseRedcapDictionary', () => {
  const schema = parseRedcapDictionary(DICT, DATA_COLUMNS)
  const byId = (name: string) => schema.questions.find((q) => q.name === name)

  it('reports its source and the record identifier', () => {
    expect(schema.source).toBe('redcap')
    expect(schema.respondentIdColumn).toBe('record_id')
  })

  it('skips fields that carry no answer', () => {
    expect(byId('banniere')).toBeUndefined()
  })

  it('maps a radio to select_one with its choices', () => {
    const q = byId('type_structure')!
    expect(q.kind).toBe('select_one')
    expect(questionColumns(q)).toEqual(['type_structure'])
    expect(questionChoices(schema, q)).toEqual([
      { name: 'chu_chr', label: { en: 'CHU/CHR' } },
      { name: 'ch', label: { en: 'Centre Hospitalier' } },
      { name: 'autre', label: { en: 'Autre' } },
    ])
    expect(q.section).toBe('Votre établissement')
    expect(q.measure).toBe('nominal')
  })

  it('reads a text field as numeric only when its validation says so', () => {
    expect(byId('lits_reanimation')!.kind).toBe('integer')
    expect(byId('lits_reanimation')!.measure).toBe('continuous')
    expect(byId('remarques')!.kind).toBe('text')
  })

  it('gives a yesno field implicit 1/0 choices', () => {
    const q = byId('zone_dechocage')!
    expect(q.kind).toBe('select_one')
    expect(questionChoices(schema, q).map((c) => c.name)).toEqual(['1', '0'])
    expect(questionChoices(schema, q)[0].label.en).toBe('Yes')
  })

  it('expands a checkbox into a one-hot binding, one column per choice', () => {
    const q = byId('usi_specialites')!
    expect(q.kind).toBe('select_multiple')
    expect(q.binding).toEqual({
      kind: 'one_hot',
      columns: [
        { code: 'usic', column: 'usi_specialites___usic' },
        { code: 'usinv', column: 'usi_specialites___usinv' },
        { code: 'autres', column: 'usi_specialites___autres' },
      ],
    })
    expect(questionChoices(schema, q)[0].label.en).toBe('USI de Cardiologie')
  })

  it('treats consecutive integer codes as an ordinal scale', () => {
    expect(byId('satisfaction')!.measure).toBe('ordinal')
    expect(byId('satisfaction')!.kind).toBe('select_one')
  })

  it('keeps branching logic so a conditional denominator can be flagged', () => {
    expect(byId('precision_dechocage')!.relevant).toBe("[zone_dechocage] = '1'")
  })

  it('derives a short label from the variable name', () => {
    expect(byId('type_structure')!.shortLabel).toBe('Type structure')
  })

  it('drops questions whose columns are absent from the export', () => {
    const partial = parseRedcapDictionary(DICT, ['record_id', 'type_structure'])
    expect(partial.questions.map((q) => q.name)).toEqual(['record_id', 'type_structure'])
  })

  it('keeps only the checkbox choices that were actually exported', () => {
    const partial = parseRedcapDictionary(DICT, [...DATA_COLUMNS].filter((c) => c !== 'usi_specialites___autres'))
    const q = partial.questions.find((x) => x.name === 'usi_specialites')!
    expect(questionColumns(q)).toEqual(['usi_specialites___usic', 'usi_specialites___usinv'])
  })

  it('derives checkbox columns from the codes when no data columns are given', () => {
    const q = parseRedcapDictionary(DICT).questions.find((x) => x.name === 'usi_specialites')!
    expect(questionColumns(q)).toEqual([
      'usi_specialites___usic',
      'usi_specialites___usinv',
      'usi_specialites___autres',
    ])
  })
})

describe('isRedcapSystemColumn', () => {
  it('recognises the per-form bookkeeping columns', () => {
    expect(isRedcapSystemColumn('organisation_complete')).toBe(true)
    expect(isRedcapSystemColumn('introduction_timestamp')).toBe(true)
    expect(isRedcapSystemColumn('redcap_event_name')).toBe(true)
  })

  it('leaves real answer columns alone', () => {
    expect(isRedcapSystemColumn('type_structure')).toBe(false)
  })
})
