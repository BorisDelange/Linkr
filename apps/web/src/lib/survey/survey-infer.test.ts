import { describe, it, expect } from 'vitest'
import { inferSurveySchema } from './survey-infer'
import { questionColumns, questionChoices } from './survey-schema'
import { summarizeQuestion } from './survey-analysis'
import type { DatasetColumn } from '@/types'

/** Terse column builder — ids match names, which is what the widget sees. */
function col(name: string, type: DatasetColumn['type'], extra: Partial<DatasetColumn> = {}): DatasetColumn {
  return { id: name, name, type, order: 0, ...extra }
}

describe('inferSurveySchema — one-hot groups', () => {
  const columns = [
    col('usi___usic', 'number', { label: 'USI de Cardiologie', description: 'Quelles USI ?' }),
    col('usi___usinv', 'number', { label: 'USI Neuro-Vasculaires', description: 'Quelles USI ?' }),
    col('usi___usih', 'number', { label: "USI d'Hématologie", description: 'Quelles USI ?' }),
  ]
  const rows = [
    { usi___usic: 1, usi___usinv: 0, usi___usih: 1 },
    { usi___usic: 0, usi___usinv: 1, usi___usih: 0 },
  ]

  it('folds REDCap-style ___ columns into one multi question', () => {
    const schema = inferSurveySchema(columns, rows)
    expect(schema.questions).toHaveLength(1)
    const q = schema.questions[0]
    expect(q.kind).toBe('select_multiple')
    expect(q.name).toBe('usi')
    expect(questionColumns(q)).toEqual(['usi___usic', 'usi___usinv', 'usi___usih'])
  })

  it('takes the question text from the description and the option from the label', () => {
    const schema = inferSurveySchema(columns, rows)
    const q = schema.questions[0]
    expect(q.label).toEqual({ und: 'Quelles USI ?' })
    expect(questionChoices(schema, q).map((c) => c.label.und)).toEqual([
      'USI de Cardiologie',
      'USI Neuro-Vasculaires',
      "USI d'Hématologie",
    ])
  })

  it('folds Goupile-style dotted columns too', () => {
    const dotted = [
      col('recours.detresse', 'number', { label: 'Détresse vitale' }),
      col('recours.debriefing', 'number', { label: 'Débriefing' }),
    ]
    const q = inferSurveySchema(dotted, [{ 'recours.detresse': 1, 'recours.debriefing': 0 }]).questions[0]
    expect(q.kind).toBe('select_multiple')
    expect(questionColumns(q)).toHaveLength(2)
  })

  it('does not group columns that merely share a prefix but are not flags', () => {
    const address = [col('adresse.rue', 'string'), col('adresse.ville', 'string')]
    const rows2 = [{ 'adresse.rue': '1 rue de la Paix', 'adresse.ville': 'Rennes' }]
    const schema = inferSurveySchema(address, rows2)
    expect(schema.questions.every((q) => q.kind !== 'select_multiple')).toBe(true)
    expect(schema.questions).toHaveLength(2)
  })

  it('does not turn a lone dotted column into a multi question', () => {
    const schema = inferSurveySchema([col('a.b', 'number')], [{ 'a.b': 1 }])
    expect(schema.questions[0].kind).not.toBe('select_multiple')
  })
})

describe('inferSurveySchema — single columns', () => {
  it('trusts declared valueLabels as the choice list', () => {
    const columns = [col('type', 'string', { valueLabels: { chu: 'CHU', ch: 'CH' }, description: 'Type ?' })]
    const schema = inferSurveySchema(columns, [{ type: 'chu' }])
    const q = schema.questions[0]
    expect(q.kind).toBe('select_one')
    expect(questionChoices(schema, q)).toEqual([
      { name: 'chu', label: { und: 'CHU' } },
      { name: 'ch', label: { und: 'CH' } },
    ])
  })

  it('reads consecutive integer labels as an ordered scale', () => {
    const columns = [col('satisfaction', 'number', { valueLabels: { 1: 'Pas du tout', 2: 'Peu', 3: 'Neutre', 4: 'Satisfait', 5: 'Très' } })]
    expect(inferSurveySchema(columns, [{ satisfaction: 3 }]).questions[0].measure).toBe('ordinal')
  })

  it('keeps a real measurement numeric', () => {
    const columns = [col('lits', 'number')]
    const rows = Array.from({ length: 40 }, (_, i) => ({ lits: i + 1 }))
    expect(inferSurveySchema(columns, rows).questions[0].measure).toBe('continuous')
  })

  it('reads a 0/1 column as yes/no rather than as a quantity', () => {
    const columns = [col('zone_dechocage', 'number')]
    const rows = [{ zone_dechocage: 1 }, { zone_dechocage: 0 }, { zone_dechocage: 1 }]
    const schema = inferSurveySchema(columns, rows)
    const q = schema.questions[0]
    expect(q.kind).toBe('select_one')
    expect(questionChoices(schema, q).map((c) => c.name)).toEqual(['1', '0'])
  })

  it('reads a numeric column with few distinct consecutive codes as a scale', () => {
    const columns = [col('note', 'number')]
    const rows = [{ note: 1 }, { note: 2 }, { note: 3 }, { note: 2 }, { note: 1 }]
    expect(inferSurveySchema(columns, rows).questions[0].measure).toBe('ordinal')
  })

  it('reads a low-cardinality string column as single choice', () => {
    const columns = [col('region', 'string')]
    const rows = [{ region: 'idf' }, { region: 'bretagne' }, { region: 'idf' }, { region: 'ara' }]
    const schema = inferSurveySchema(columns, rows)
    const q = schema.questions[0]
    expect(q.kind).toBe('select_one')
    expect(questionChoices(schema, q).map((c) => c.name)).toEqual(['ara', 'bretagne', 'idf'])
  })

  it('reads a mostly-unique string column as free text, not a choice list', () => {
    const columns = [col('remarques', 'string')]
    const rows = Array.from({ length: 20 }, (_, i) => ({ remarques: `commentaire unique ${i}` }))
    expect(inferSurveySchema(columns, rows).questions[0].kind).toBe('text')
  })

  it('reads a date column as a date question', () => {
    expect(inferSurveySchema([col('d', 'date')], [{ d: '2025-01-01' }]).questions[0].kind).toBe('date')
  })
})

describe('inferSurveySchema — housekeeping', () => {
  it('drops system and bookkeeping columns', () => {
    const columns = [
      col('__tid', 'string'),
      col('__sequence', 'number'),
      col('organisation_complete', 'number'),
      col('region', 'string'),
    ]
    const schema = inferSurveySchema(columns, [{ __tid: 'T1', __sequence: 1, organisation_complete: 2, region: 'idf' }])
    expect(schema.questions.map((q) => q.name)).toEqual(['region'])
  })

  it('reports the respondent id column when there is one', () => {
    const schema = inferSurveySchema([col('record_id', 'string')], [{ record_id: '1' }])
    expect(schema.respondentIdColumn).toBe('record_id')
  })

  it('keeps questions in dataset column order', () => {
    const columns = [col('b', 'string'), col('a', 'string')]
    const schema = inferSurveySchema(columns, [{ a: 'x', b: 'y' }])
    expect(schema.questions.map((q) => q.name)).toEqual(['b', 'a'])
  })

  it('handles an empty dataset without throwing', () => {
    expect(inferSurveySchema([], []).questions).toEqual([])
  })

  it('handles columns with no rows at all', () => {
    const schema = inferSurveySchema([col('x', 'string')], [])
    expect(schema.questions).toHaveLength(1)
    expect(schema.questions[0].kind).toBe('text')
  })

  it('still groups one-hot columns with no rows — server mode ships none', () => {
    const columns = [
      col('usi___usic', 'number', { label: 'Cardiologie', description: 'Quelles USI ?' }),
      col('usi___usinv', 'number', { label: 'Neuro-vasculaire', description: 'Quelles USI ?' }),
    ]
    const q = inferSurveySchema(columns, []).questions[0]
    expect(q.kind).toBe('select_multiple')
    expect(questionColumns(q)).toEqual(['usi___usic', 'usi___usinv'])
  })

  it('does not group non-numeric same-prefix columns when there are no rows', () => {
    const columns = [col('adresse.rue', 'string'), col('adresse.ville', 'string')]
    const schema = inferSurveySchema(columns, [])
    expect(schema.questions.every((q) => q.kind !== 'select_multiple')).toBe(true)
  })

  /**
   * Regression: a radio named after a checkbox group's parent is the ordinary
   * REDCap shape, and both used to be filed under the bare parent name — so the
   * plain column's write erased the group's choice list (leaving it undefined)
   * and two questions shared one name. The widget picks by column, so selecting a
   * checkbox charted the radio's options with every bar at zero.
   */
  it('keeps a group and a same-named plain column apart', () => {
    const columns = [
      col('usi', 'string', { label: 'USI principale' }),
      col('usi___usic', 'number', { label: 'Cardiologie' }),
      col('usi___usinv', 'number', { label: 'Neuro-vasculaire' }),
    ]
    const rows = [
      { usi: 'cardio', usi___usic: 1, usi___usinv: 0 },
      { usi: 'neuro', usi___usic: 1, usi___usinv: 1 },
    ]
    const schema = inferSurveySchema(columns, rows)

    const names = schema.questions.map((q) => q.name)
    expect(new Set(names).size).toBe(names.length)

    const group = schema.questions.find((q) => q.kind === 'select_multiple')!
    const plain = schema.questions.find((q) => q.binding.kind === 'single_column')!
    // The group is declared first, so it keeps the unqualified name.
    expect(group.name).toBe('usi')
    expect(questionChoices(schema, group).map((c) => c.name)).toEqual(['usic', 'usinv'])
    expect(questionChoices(schema, plain).map((c) => c.name)).toEqual(['cardio', 'neuro'])
  })
})

describe('yes/no questions, however each side spells them', () => {
  // Regression: `oui`/`non` are recognized boolean tokens, so the column is
  // TYPED boolean at import — but remapRows only renames keys, it does not
  // coerce, so the cells stay 'oui'/'non' strings while the importer's
  // valueLabels key on 'oui'/'non' and the inference declares 'true'/'false'.
  // Matching on the raw string split ONE question into two rival pairs, one of
  // them always at zero: "True 0 / False 0 / oui 44 / non 137".
  const shapes: [string, unknown, unknown][] = [
    ['as exported (strings)', 'oui', 'non'],
    ['after coercion (booleans)', true, false],
    ['english spelling', 'Yes', 'No'],
  ]
  const labelSets: (Record<string, string> | undefined)[] = [
    { oui: 'Oui', non: 'Non' },
    undefined,
  ]

  for (const [what, yes, no] of shapes) {
    for (const valueLabels of labelSets) {
      it(`counts one pair — ${what}, ${valueLabels ? 'declared' : 'inferred'} labels`, () => {
        const rows = [
          ...Array.from({ length: 44 }, () => ({ zone_dechocage: yes })),
          ...Array.from({ length: 137 }, () => ({ zone_dechocage: no })),
          ...Array.from({ length: 33 }, () => ({ zone_dechocage: null })),
        ]
        const column = col('zone_dechocage', 'boolean', valueLabels ? { valueLabels } : {})
        const schema = inferSurveySchema([column], rows)
        const q = schema.questions.find((x) => x.name === 'zone_dechocage')!
        const summary = summarizeQuestion(schema, q, rows, 'fr')
        expect([summary.total, summary.respondents, summary.missing]).toEqual([214, 181, 33])
        // Two rows, never four: no undeclared spelling shows up alongside.
        expect(summary.counts).toHaveLength(2)
        expect(summary.counts.map((c) => c.count)).toEqual([44, 137])
      })
    }
  }
})
