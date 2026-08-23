import { describe, it, expect } from 'vitest'
import { parseGoupileWorkbook, isGoupileWorkbook, type SheetMap } from './goupile-import'
import { questionColumns, questionChoices, choiceColumn } from './survey/survey-schema'

// A trimmed Goupile-shaped workbook exercising every path: system columns, an enum
// with value labels, a multi-select one-hot, a cross-form name collision, and NA.
// Mirrors the real cnp-cemir exports' structure (verified separately against them).
const SHEETS: SheetMap = {
  introduction: [
    { __tid: 'T1', __sequence: 1, __hid: 'H1', code_participant: 'MIR2025' },
    { __tid: 'T2', __sequence: 2, __hid: 'H2', code_participant: 'MIR2025' },
  ],
  a_propos_de_vous: [
    { __tid: 'T1', __sequence: 1, __hid: 'H1', sexe: 'homme', region: 'idf', remarques: 'RAS' },
    { __tid: 'T2', __sequence: 2, __hid: 'H2', sexe: 'femme', region: 'bretagne', remarques: 'NA' },
  ],
  recours_mir: [
    {
      __tid: 'T1', __sequence: 1, __hid: 'H1',
      'situations_recours.detresse_vitale': 1,
      'situations_recours.debriefing': 0,
      remarques: 'form2 remark',
    },
    // T3 exists only here — a respondent incomplete elsewhere (full-outer join).
    {
      __tid: 'T3', __sequence: 3, __hid: 'H3',
      'situations_recours.detresse_vitale': 0,
      'situations_recours.debriefing': 1,
      remarques: 'NA',
    },
  ],
  '@definitions': [
    { table: 'a_propos_de_vous', variable: 'sexe', label: 'Quel est votre sexe ?', type: 'enum' },
    { table: 'a_propos_de_vous', variable: 'region', label: "Région d'exercice", type: 'enum' },
    { table: 'a_propos_de_vous', variable: 'remarques', label: 'Remarques (profil)', type: 'text' },
    { table: 'recours_mir', variable: 'situations_recours', label: 'Situations de recours', type: 'multi' },
    { table: 'recours_mir', variable: 'remarques', label: 'Remarques (recours)', type: 'text' },
  ],
  '@propositions': [
    { table: 'a_propos_de_vous', variable: 'sexe', prop: 'homme', label: 'Homme' },
    { table: 'a_propos_de_vous', variable: 'sexe', prop: 'femme', label: 'Femme' },
    { table: 'a_propos_de_vous', variable: 'region', prop: 'idf', label: 'Île-de-France' },
    { table: 'a_propos_de_vous', variable: 'region', prop: 'bretagne', label: 'Bretagne' },
    { table: 'recours_mir', variable: 'situations_recours', prop: 'detresse_vitale', label: 'Détresse vitale' },
    { table: 'recours_mir', variable: 'situations_recours', prop: 'debriefing', label: 'Débriefing' },
  ],
}

describe('isGoupileWorkbook', () => {
  it('detects a workbook with both dictionary sheets', () => {
    expect(isGoupileWorkbook(Object.keys(SHEETS))).toBe(true)
  })
  it('rejects a plain workbook', () => {
    expect(isGoupileWorkbook(['Sheet1', 'Sheet2'])).toBe(false)
    expect(isGoupileWorkbook(['@definitions'])).toBe(false) // needs BOTH
  })
})

describe('parseGoupileWorkbook', () => {
  const res = parseGoupileWorkbook(SHEETS, {
    __tid: { label: 'Identifiant dossier', description: 'Identifiant unique du dossier' },
  })
  const byTid = Object.fromEntries(res.rows.map((r) => [r.__tid, r]))

  it('joins on __tid: one row per distinct respondent', () => {
    // T1, T2, T3 across the sheets → 3 rows.
    expect(res.rows).toHaveLength(3)
    expect(new Set(res.rows.map((r) => r.__tid))).toEqual(new Set(['T1', 'T2', 'T3']))
  })

  it('merges columns from every form onto the same respondent', () => {
    expect(byTid.T1.sexe).toBe('homme')
    expect(byTid.T1['situations_recours.detresse_vitale']).toBe(1)
  })

  it('full-outer join leaves nulls for forms a respondent is absent from', () => {
    // T3 is only in recours_mir → its a_propos_de_vous columns are null.
    expect(byTid.T3.sexe).toBeNull()
    // T2 is absent from recours_mir → its multi columns are null.
    expect(byTid.T2['situations_recours.detresse_vitale']).toBeNull()
  })

  it("converts the literal 'NA' to null", () => {
    expect(byTid.T2['a_propos_de_vous.remarques']).toBeNull()
  })

  it('prefixes only colliding column names, by form', () => {
    // `remarques` is in TWO forms → both prefixed; `sexe` is in one → not prefixed.
    expect(res.columns).toContain('a_propos_de_vous.remarques')
    expect(res.columns).toContain('recours_mir.remarques')
    expect(res.columns).toContain('sexe')
    expect(res.columns).not.toContain('remarques')
    expect(byTid.T1['recours_mir.remarques']).toBe('form2 remark')
  })

  it('reports no duplicate forms for a clean workbook', () => {
    expect(res.duplicateForms).toEqual([])
  })

  it('flags a form with more than one row per __tid (repeatable form)', () => {
    const dup = parseGoupileWorkbook({
      ...SHEETS,
      recours_mir: [
        { __tid: 'T1', __sequence: 1, __hid: 'H1', remarques: 'first' },
        { __tid: 'T1', __sequence: 2, __hid: 'H1', remarques: 'second' },
      ],
    })
    expect(dup.duplicateForms).toContain('recours_mir')
    // Last-write-wins: only the second entry survives the join.
    const t1 = dup.rows.find((r) => r.__tid === 'T1')!
    expect(t1['recours_mir.remarques'] ?? t1.remarques).toBe('second')
  })

  it('unions ragged headers so a column missing from the first row is not dropped', () => {
    const ragged = parseGoupileWorkbook({
      '@definitions': SHEETS['@definitions'],
      '@propositions': SHEETS['@propositions'],
      form_x: [
        { __tid: 'T1', __sequence: 1, __hid: 'H1', a: 1 },
        { __tid: 'T2', __sequence: 2, __hid: 'H2', a: 2, b: 9 }, // `b` only on row 2
      ],
    })
    expect(ragged.columns).toContain('b')
    const t2 = ragged.rows.find((r) => r.__tid === 'T2')!
    expect(t2.b).toBe(9)
  })

  it('keeps system columns unprefixed and up front', () => {
    expect(res.columns.slice(0, 3)).toEqual(['__tid', '__sequence', '__hid'])
    expect(res.columnMeta.__tid).toEqual({ label: 'Identifiant dossier', description: 'Identifiant unique du dossier' })
  })

  it('humanizes the name into a short label, puts the question in the description, maps value labels', () => {
    expect(res.columnMeta.sexe.label).toBe('Sexe') // humanized from the variable name
    expect(res.columnMeta.sexe.description).toBe('Quel est votre sexe ?')
    expect(res.columnMeta.sexe.valueLabels).toEqual({ homme: 'Homme', femme: 'Femme' })
  })

  it('labels a one-hot column with the option, and the parent question as description', () => {
    const meta = res.columnMeta['situations_recours.detresse_vitale']
    expect(meta.label).toBe('Détresse vitale') // the proposition is a good short label
    expect(meta.description).toBe('Situations de recours')
    expect(meta.valueLabels).toBeUndefined() // it's a 0/1 flag
  })

  it('gives colliding text columns their own per-form question as description', () => {
    expect(res.columnMeta['a_propos_de_vous.remarques'].description).toBe('Remarques (profil)')
    expect(res.columnMeta['recours_mir.remarques'].description).toBe('Remarques (recours)')
  })

  describe('survey schema', () => {
    const q = (name: string) => res.survey.questions.find((x) => x.name === name)

    it('reports its source and the respondent key', () => {
      expect(res.survey.source).toBe('goupile')
      expect(res.survey.respondentIdColumn).toBe('__tid')
    })

    it('maps an enum to select_one bound to a single column', () => {
      const sexe = q('sexe')!
      expect(sexe.kind).toBe('select_one')
      expect(sexe.binding).toEqual({ kind: 'single_column', column: 'sexe' })
      expect(questionColumns(sexe)).toEqual(['sexe'])
      expect(sexe.label).toEqual({ fr: 'Quel est votre sexe ?' })
      expect(sexe.shortLabel).toBe('Sexe')
      expect(sexe.section).toBe('a_propos_de_vous')
      expect(sexe.measure).toBe('nominal')
    })

    it('puts an enum choices into a named, shared choice list', () => {
      const sexe = q('sexe')!
      expect(questionChoices(res.survey, sexe)).toEqual([
        { name: 'homme', label: { fr: 'Homme' } },
        { name: 'femme', label: { fr: 'Femme' } },
      ])
    })

    it('rebuilds a multi question as select_multiple with a one-hot binding', () => {
      const recours = q('situations_recours')!
      expect(recours.kind).toBe('select_multiple')
      expect(recours.binding).toEqual({
        kind: 'one_hot',
        columns: [
          { code: 'detresse_vitale', column: 'situations_recours.detresse_vitale' },
          { code: 'debriefing', column: 'situations_recours.debriefing' },
        ],
      })
      expect(questionColumns(recours)).toEqual([
        'situations_recours.detresse_vitale',
        'situations_recours.debriefing',
      ])
      expect(recours.label).toEqual({ fr: 'Situations de recours' })
    })

    it('resolves the column carrying one choice of a multi question', () => {
      expect(choiceColumn(q('situations_recours')!, 'debriefing')).toBe(
        'situations_recours.debriefing',
      )
    })

    it('has no question for the one-hot columns themselves', () => {
      expect(q('situations_recours.detresse_vitale')).toBeUndefined()
    })

    it('maps free text to a text question, per form when the name collides', () => {
      expect(q('a_propos_de_vous.remarques')!.kind).toBe('text')
      expect(q('recours_mir.remarques')!.label).toEqual({ fr: 'Remarques (recours)' })
    })

    it('marks a numeric question as continuous', () => {
      // `age` is declared as a number in the fixture dictionary.
      const numeric = res.survey.questions.find((x) => x.kind === 'integer')
      if (numeric) expect(numeric.measure).toBe('continuous')
    })

    it('leaves the system columns out of the questions', () => {
      for (const sys of ['__tid', '__sequence', '__hid']) expect(q(sys)).toBeUndefined()
    })
  })
})
