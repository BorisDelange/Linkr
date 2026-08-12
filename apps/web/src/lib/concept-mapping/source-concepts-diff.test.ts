import { describe, it, expect } from 'vitest'
import {
  diffSourceConcepts,
  parseSourceConceptsCsv,
  sourceConceptsDiffIsEmpty,
  mergeSourceConceptsCsv,
} from './source-concepts-diff'

const HEADER = 'vocabulary_id,concept_code,concept_name,domain'

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n')

describe('parseSourceConceptsCsv', () => {
  it('keys rows by (vocabulary_id, concept_code)', () => {
    const rows = parseSourceConceptsCsv(csv('LOCAL,VC,Volume courant,Measurement'))
    expect(rows?.size).toBe(1)
    expect(rows?.get('LOCAL|VC')?.code).toBe('VC')
  })

  it('accepts the alternative header names the app writes', () => {
    const rows = parseSourceConceptsCsv('terminology,code\nLOCAL,VC')
    expect(rows?.get('LOCAL|VC')).toBeDefined()
  })

  it('is case-insensitive on the header', () => {
    const rows = parseSourceConceptsCsv('Vocabulary_ID,Concept_Code\nLOCAL,VC')
    expect(rows?.get('LOCAL|VC')).toBeDefined()
  })

  it('handles quoted cells containing commas', () => {
    const rows = parseSourceConceptsCsv(csv('LOCAL,VC,"Volume, courant",Measurement'))
    expect(rows?.size).toBe(1)
    expect(rows?.get('LOCAL|VC')?.content).toContain('Volume, courant')
  })

  it('returns null for an unsmudged LFS pointer', () => {
    expect(parseSourceConceptsCsv('version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 12')).toBeNull()
  })

  it('returns null when an identity column is missing', () => {
    expect(parseSourceConceptsCsv('concept_name,domain\nVolume,Measurement')).toBeNull()
  })

  it('uses the project columnMapping for a user-named CSV', () => {
    // The real RiCDC/mimic-iv export: `terminology_code` is in no guess list, so
    // name-guessing alone declared a perfectly good file uncomparable.
    const csvText = 'terminology_code,concept_code,concept_label\nmimic_outputevents,226559,Foley'
    expect(parseSourceConceptsCsv(csvText)).toBeNull()
    const rows = parseSourceConceptsCsv(csvText, {
      terminologyColumn: 'terminology_code',
      conceptCodeColumn: 'concept_code',
    })
    expect(rows?.get('mimic_outputevents|226559')).toBeDefined()
  })

  it('falls back to the guessed names when the mapping is stale', () => {
    const rows = parseSourceConceptsCsv(csv('LOCAL,VC,Volume,M'), {
      terminologyColumn: 'gone_column',
      conceptCodeColumn: 'also_gone',
    })
    expect(rows?.get('LOCAL|VC')).toBeDefined()
  })

  it('returns null on empty or absent content', () => {
    expect(parseSourceConceptsCsv('')).toBeNull()
    expect(parseSourceConceptsCsv(null)).toBeNull()
  })

  it('skips rows with no concept_code (no identity)', () => {
    const rows = parseSourceConceptsCsv(csv('LOCAL,,No code,Measurement', 'LOCAL,VC,Volume,Measurement'))
    expect(rows?.size).toBe(1)
  })

  it('ignores blank lines and a trailing newline', () => {
    const rows = parseSourceConceptsCsv(`${csv('LOCAL,VC,Volume,Measurement')}\n\n`)
    expect(rows?.size).toBe(1)
  })
})

describe('diffSourceConcepts', () => {
  it('counts added, removed and modified by identity pair', () => {
    const local = parseSourceConceptsCsv(csv(
      'LOCAL,A,Alpha,Measurement',
      'LOCAL,B,Beta,Measurement',
      'LOCAL,C,Gamma,Measurement',
    ))
    const remote = parseSourceConceptsCsv(csv(
      'LOCAL,A,Alpha,Measurement', // unchanged
      'LOCAL,B,Beta renamed,Measurement', // modified
      'LOCAL,D,Delta,Measurement', // added
      // C removed
    ))
    const d = diffSourceConcepts(local, remote)
    expect(d).toMatchObject({ added: 1, removed: 1, modified: 1, unchanged: 1, keyed: true })
    expect(d.localTotal).toBe(3)
    expect(d.remoteTotal).toBe(3)
  })

  it('treats the same code in a different vocabulary as a distinct concept', () => {
    const local = parseSourceConceptsCsv(csv('LOINC,1234-5,X,Measurement'))
    const remote = parseSourceConceptsCsv(csv('SNOMED,1234-5,X,Measurement'))
    expect(diffSourceConcepts(local, remote)).toMatchObject({ added: 1, removed: 1, modified: 0 })
  })

  it('reports no change when both sides are identical', () => {
    const rows = () => parseSourceConceptsCsv(csv('LOCAL,A,Alpha,Measurement'))
    const d = diffSourceConcepts(rows(), rows())
    expect(sourceConceptsDiffIsEmpty(d)).toBe(true)
  })

  it('is not keyed when either side could not be parsed', () => {
    const rows = parseSourceConceptsCsv(csv('LOCAL,A,Alpha,Measurement'))
    expect(diffSourceConcepts(null, rows).keyed).toBe(false)
    expect(diffSourceConcepts(rows, null).keyed).toBe(false)
    // An unkeyed diff must never look like "nothing to pull".
    expect(sourceConceptsDiffIsEmpty(diffSourceConcepts(null, rows))).toBe(false)
  })

  it('counts every remote row as added against an empty local list', () => {
    const remote = parseSourceConceptsCsv(csv('LOCAL,A,Alpha,M', 'LOCAL,B,Beta,M'))
    const d = diffSourceConcepts(new Map(), remote)
    expect(d).toMatchObject({ added: 2, removed: 0, modified: 0, keyed: true })
  })
})

describe('mergeSourceConceptsCsv — a refusal that actually holds', () => {
  const rowsOf = (out: string) => out.trim().split('\n').slice(1).sort()

  it('returns the remote file untouched when nothing was refused', () => {
    const remote = csv('LOCAL,A,Alpha,M')
    expect(mergeSourceConceptsCsv(csv('LOCAL,B,Beta,M'), remote, new Set())).toBe(remote)
  })

  it('drops a refused ADDITION rather than taking it', () => {
    const local = csv('LOCAL,A,Alpha,M')
    const remote = csv('LOCAL,A,Alpha,M', 'LOCAL,B,Beta,M')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B']))!
    expect(rowsOf(out)).toEqual(['LOCAL,A,Alpha,M'])
  })

  it('keeps a row whose REMOVAL was refused', () => {
    const local = csv('LOCAL,A,Alpha,M', 'LOCAL,B,Beta,M')
    const remote = csv('LOCAL,A,Alpha,M')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B']))!
    expect(rowsOf(out)).toEqual(['LOCAL,A,Alpha,M', 'LOCAL,B,Beta,M'])
  })

  it('keeps MY version of a row whose change was refused', () => {
    const local = csv('LOCAL,A,Mine,M')
    const remote = csv('LOCAL,A,Theirs,M')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|A']))!
    expect(rowsOf(out)).toEqual(['LOCAL,A,Mine,M'])
  })

  it('takes the accepted changes while refusing the others', () => {
    const local = csv('LOCAL,A,Alpha,M', 'LOCAL,B,Beta,M')
    const remote = csv('LOCAL,A,Alpha renamed,M', 'LOCAL,C,Gamma,M')
    // Refuse the removal of B and the addition of C; accept A's rename.
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B', 'LOCAL|C']))!
    expect(rowsOf(out)).toEqual(['LOCAL,A,Alpha renamed,M', 'LOCAL,B,Beta,M'])
  })

  it('re-emits a kept local row under the REMOTE header, so the file stays rectangular', () => {
    const local = 'vocabulary_id,concept_code,concept_name,extra\nLOCAL,B,Beta,dropped'
    const remote = 'vocabulary_id,concept_code,concept_name\nLOCAL,A,Alpha'
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B']))!
    const lines = out.trim().split('\n')
    expect(lines[0]).toBe('vocabulary_id,concept_code,concept_name')
    expect(lines.every((l) => l.split(',').length === 3)).toBe(true)
  })

  it('re-quotes a kept row that contains a comma', () => {
    const local = csv('LOCAL,B,"Beta, extended",M')
    const remote = csv('LOCAL,A,Alpha,M')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B']))!
    expect(out).toContain('"Beta, extended"')
    // Round-trips: the merged file still parses to two rows.
    expect(parseSourceConceptsCsv(out)?.size).toBe(2)
  })

  it('refuses the merge when a side cannot be keyed', () => {
    // Silently falling back to "take everything" would apply changes the user
    // explicitly refused.
    const remote = csv('LOCAL,A,Alpha,M')
    expect(mergeSourceConceptsCsv(null, remote, new Set(['LOCAL|A']))).toBeNull()
    expect(mergeSourceConceptsCsv('version https://git-lfs', remote, new Set(['LOCAL|A']))).toBeNull()
  })

  it('honours the project column mapping on both sides', () => {
    const header = 'terminology_code,concept_code,concept_label'
    const mapping = { terminologyColumn: 'terminology_code', conceptCodeColumn: 'concept_code' }
    const local = [header, 'mimic,A,Alpha', 'mimic,B,Beta'].join('\n')
    const remote = [header, 'mimic,A,Alpha'].join('\n')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['mimic|B']), mapping)!
    expect(rowsOf(out)).toEqual(['mimic,A,Alpha', 'mimic,B,Beta'])
  })
})

describe('duplicate pairs and multiline fields (the real RiCDC export)', () => {
  it('keeps every physical row when a (vocab, code) pair repeats', () => {
    // MIMIC ships "Acetaminophen" and "Acetaminophen " as separate concepts: 345
    // such pairs in the real export. Keying on the pair alone collapsed them.
    const rows = parseSourceConceptsCsv(csv(
      'mimic,Acetaminophen,Acetaminophen,M',
      'mimic,Acetaminophen,Acetaminophen ,M',
    ))
    expect(rows?.size).toBe(2)
  })

  it('does not report a duplicated pair as a change when both sides match', () => {
    const same = csv('mimic,A,First,M', 'mimic,A,Second,M')
    const d = diffSourceConcepts(parseSourceConceptsCsv(same), parseSourceConceptsCsv(same))
    expect(sourceConceptsDiffIsEmpty(d)).toBe(true)
  })

  it('never drops a duplicated row when merging around a refusal', () => {
    // The dangerous case: a refusal used to rebuild the CSV from a pair-keyed map,
    // silently losing every repeat.
    const local = csv('mimic,A,First,M', 'mimic,A,Second,M', 'mimic,B,Beta,M')
    const remote = csv('mimic,A,First,M', 'mimic,A,Second,M')
    const out = mergeSourceConceptsCsv(local, remote, new Set(['mimic|B']))!
    expect(parseSourceConceptsCsv(out)?.size).toBe(3)
  })

  it('parses a quoted field containing newlines as ONE row', () => {
    // metadata_json holds JSON, which can wrap. A naive split('\n') cut one
    // concept into several half-rows and shifted every later column.
    const text = `${HEADER}\nLOCAL,A,"line1\nline2",M`
    const rows = parseSourceConceptsCsv(text)
    expect(rows?.size).toBe(1)
    expect(rows?.get('LOCAL|A')?.content).toContain('line1\nline2')
  })

  it('round-trips a multiline field through a merge', () => {
    const local = `${HEADER}\nLOCAL,B,"a\nb",M`
    const remote = `${HEADER}\nLOCAL,A,Alpha,M`
    const out = mergeSourceConceptsCsv(local, remote, new Set(['LOCAL|B']))!
    expect(parseSourceConceptsCsv(out)?.size).toBe(2)
    expect(parseSourceConceptsCsv(out)?.get('LOCAL|B')?.content).toContain('a\nb')
  })
})
