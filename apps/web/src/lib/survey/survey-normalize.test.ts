import { describe, it, expect } from 'vitest'
import { normalizeSurvey, splitDelimited, expandedColumnName } from './survey-normalize'
import { questionColumns, type SurveySchema } from './survey-schema'

const DELIMITED: SurveySchema = {
  source: 'xlsform',
  questions: [
    {
      name: 'nom',
      kind: 'text',
      label: { fr: 'Nom' },
      binding: { kind: 'single_column', column: 'nom' },
    },
    {
      name: 'usi',
      kind: 'select_multiple',
      listName: 'usi',
      label: { fr: 'Quelles USI ?' },
      binding: { kind: 'delimited', column: 'usi', separator: ' ', valueKind: 'code' },
    },
  ],
  choices: {
    usi: [
      { name: 'usic', label: { fr: 'Cardiologie' } },
      { name: 'usinv', label: { fr: 'Neuro-vasculaire' } },
    ],
  },
}

const COLUMNS = ['nom', 'usi']
const ROWS = [
  { nom: 'CHU A', usi: 'usic usinv' },
  { nom: 'CH B', usi: 'usic' },
  { nom: 'CH C', usi: '' },
]

describe('splitDelimited', () => {
  it('splits on a space, tolerating runs of whitespace', () => {
    expect(splitDelimited('a  b   c', ' ')).toEqual(['a', 'b', 'c'])
  })

  it('splits on a literal separator and trims each part', () => {
    expect(splitDelimited('a; b ;c', ';')).toEqual(['a', 'b', 'c'])
  })

  it('returns nothing for a blank or missing cell', () => {
    for (const v of ['', '   ', null, undefined]) expect(splitDelimited(v, ' ')).toEqual([])
  })
})

describe('expandedColumnName', () => {
  it("mirrors ODK's question/choice convention", () => {
    expect(expandedColumnName('usi', 'usic')).toBe('usi/usic')
  })
})

describe('normalizeSurvey', () => {
  const res = normalizeSurvey(DELIMITED, COLUMNS, ROWS)

  it('replaces the delimited column with one column per choice, in place', () => {
    expect(res.columns).toEqual(['nom', 'usi/usic', 'usi/usinv'])
  })

  it('rewrites the binding to one_hot', () => {
    const usi = res.schema.questions.find((q) => q.name === 'usi')!
    expect(usi.binding.kind).toBe('one_hot')
    expect(questionColumns(usi)).toEqual(['usi/usic', 'usi/usinv'])
  })

  it('ticks the selected choices and unticks the rest', () => {
    expect(res.rows[0]).toEqual({ nom: 'CHU A', 'usi/usic': 1, 'usi/usinv': 1 })
    expect(res.rows[1]).toEqual({ nom: 'CH B', 'usi/usic': 1, 'usi/usinv': 0 })
  })

  it('leaves a blank answer null rather than all-zero, so non-response stays visible', () => {
    expect(res.rows[2]).toEqual({ nom: 'CH C', 'usi/usic': null, 'usi/usinv': null })
  })

  it('leaves untouched columns alone', () => {
    expect(res.rows.map((r) => r.nom)).toEqual(['CHU A', 'CH B', 'CH C'])
  })

  it('is a no-op when nothing is delimited', () => {
    const oneHot: SurveySchema = {
      source: 'redcap',
      questions: [
        {
          name: 'usi',
          kind: 'select_multiple',
          label: { en: 'USI' },
          binding: { kind: 'one_hot', columns: [{ code: 'usic', column: 'usi___usic' }] },
        },
      ],
      choices: {},
    }
    const cols = ['usi___usic']
    const rows = [{ usi___usic: 1 }]
    const out = normalizeSurvey(oneHot, cols, rows)
    expect(out.columns).toBe(cols)
    expect(out.rows).toBe(rows)
    expect(out.schema).toBe(oneHot)
  })

  it('keeps a code found in the data but missing from the declared list', () => {
    const out = normalizeSurvey(DELIMITED, COLUMNS, [{ nom: 'X', usi: 'usic surprise' }])
    expect(out.columns).toContain('usi/surprise')
    expect(out.rows[0]['usi/surprise']).toBe(1)
    expect(out.schema.choices.usi.map((c) => c.name)).toEqual(['usic', 'usinv', 'surprise'])
  })

  it('does not mutate the schema it was given', () => {
    normalizeSurvey(DELIMITED, COLUMNS, ROWS)
    expect(DELIMITED.questions[1].binding.kind).toBe('delimited')
    expect(DELIMITED.choices.usi).toHaveLength(2)
  })

  it('handles a semicolon-delimited source', () => {
    const semi: SurveySchema = {
      ...DELIMITED,
      questions: DELIMITED.questions.map((q) =>
        q.name === 'usi'
          ? { ...q, binding: { kind: 'delimited' as const, column: 'usi', separator: ';', valueKind: 'code' as const } }
          : q,
      ),
    }
    const out = normalizeSurvey(semi, COLUMNS, [{ nom: 'X', usi: 'usic;usinv' }])
    expect(out.rows[0]).toEqual({ nom: 'X', 'usi/usic': 1, 'usi/usinv': 1 })
  })
})
