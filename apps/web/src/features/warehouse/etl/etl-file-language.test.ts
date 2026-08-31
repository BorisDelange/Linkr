import { describe, expect, it } from 'vitest'
import {
  compareEtlFilesByName,
  inferEtlLanguage,
  nextEtlOrder,
  orderByNamePatch,
  safeEtlFileName,
  uniqueEtlFileName,
  etlLanguageLabel,
} from './etl-file-language'

describe('inferEtlLanguage', () => {
  it('maps the executable extensions', () => {
    expect(inferEtlLanguage('01_person.sql')).toBe('sql')
    expect(inferEtlLanguage('clean.py')).toBe('python')
    expect(inferEtlLanguage('plot.R')).toBe('r')
  })

  it('keeps .Rmd as R, not markdown', () => {
    // It is an R notebook; matching .md first would make it documentation and
    // drop it from the run.
    expect(inferEtlLanguage('report.Rmd')).toBe('r')
  })

  it('maps .md to markdown', () => {
    expect(inferEtlLanguage('README.md')).toBe('markdown')
  })

  it('returns undefined for anything else', () => {
    expect(inferEtlLanguage('data.csv')).toBeUndefined()
    expect(inferEtlLanguage('noextension')).toBeUndefined()
  })
})

describe('safeEtlFileName', () => {
  it('keeps an ordinary name', () => {
    expect(safeEtlFileName('01_person.sql')).toBe('01_person.sql')
  })

  it('strips a path, since hierarchy lives in parentId', () => {
    expect(safeEtlFileName('sub/dir/01_person.sql')).toBe('01_person.sql')
    expect(safeEtlFileName('sub\\dir\\01_person.sql')).toBe('01_person.sql')
  })

  it('refuses the names that address the pipeline itself', () => {
    expect(safeEtlFileName('_tree.json')).toBeUndefined()
    expect(safeEtlFileName('_pipeline.json')).toBeUndefined()
  })

  it('refuses an empty or dot name', () => {
    expect(safeEtlFileName('   ')).toBeUndefined()
    expect(safeEtlFileName('..')).toBeUndefined()
  })
})

describe('uniqueEtlFileName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueEtlFileName('a.sql', ['b.sql'])).toBe('a.sql')
  })

  it('suffixes before the extension', () => {
    expect(uniqueEtlFileName('a.sql', ['a.sql'])).toBe('a-2.sql')
  })

  it('keeps counting past the first collision', () => {
    expect(uniqueEtlFileName('a.sql', ['a.sql', 'a-2.sql'])).toBe('a-3.sql')
  })

  it('compares case-insensitively, as a filesystem would', () => {
    expect(uniqueEtlFileName('A.SQL', ['a.sql'])).toBe('A-2.SQL')
  })

  it('handles a name with no extension', () => {
    expect(uniqueEtlFileName('Makefile', ['Makefile'])).toBe('Makefile-2')
  })
})

describe('compareEtlFilesByName', () => {
  const f = (name: string, type: 'file' | 'folder' = 'file') => ({ name, type })

  it('orders numeric prefixes the way they read', () => {
    // The reported bug: order-of-creation listed 35_ before 10_.
    const names = ['35_drug_exposure.sql', '00_vocabulary.sql', '10_src_code.sql']
      .map((n) => f(n))
      .sort(compareEtlFilesByName)
      .map((x) => x.name)
    expect(names).toEqual(['00_vocabulary.sql', '10_src_code.sql', '35_drug_exposure.sql'])
  })

  it('puts 2_ before 10_, which a plain string sort reverses', () => {
    const names = [f('10_b.sql'), f('2_a.sql')].sort(compareEtlFilesByName).map((x) => x.name)
    expect(names).toEqual(['2_a.sql', '10_b.sql'])
  })

  it('lists folders before files', () => {
    const out = [f('zz.sql'), f('mapping', 'folder')].sort(compareEtlFilesByName)
    expect(out[0].name).toBe('mapping')
  })

  it('is case-insensitive between names', () => {
    const names = [f('b.sql'), f('A.sql')].sort(compareEtlFilesByName).map((x) => x.name)
    expect(names).toEqual(['A.sql', 'b.sql'])
  })
})

describe('orderByNamePatch', () => {
  const f = (id: string, name: string, order: number) =>
    ({ id, name, order, type: 'file' as const })

  it('realigns execution order with the numeric prefixes', () => {
    // The real case: 35_ ran before 10_ because it was created first, so the
    // mapping steps had not populated their tables yet.
    const patch = orderByNamePatch([
      f('a', '00_vocabulary.sql', 0),
      f('b', '35_drug_exposure.sql', 1),
      f('c', '10_src_core.sql', 2),
    ])
    expect(patch.get('c')).toBe(1)
    expect(patch.get('b')).toBe(2)
  })

  it('returns nothing when the order already matches', () => {
    const patch = orderByNamePatch([
      f('a', '00_vocabulary.sql', 0),
      f('b', '10_src_core.sql', 1),
    ])
    expect(patch.size).toBe(0)
  })

  it('only reports the files that actually move', () => {
    const patch = orderByNamePatch([
      f('a', '00_a.sql', 0),
      f('c', '30_c.sql', 2),
      f('b', '20_b.sql', 1),
    ])
    // Already correct once sorted: a=0, b=1, c=2 — b and c hold 1 and 2 already.
    expect(patch.size).toBe(0)
  })

  it('handles an empty pipeline', () => {
    expect(orderByNamePatch([]).size).toBe(0)
  })
})

describe('nextEtlOrder', () => {
  it('never reuses an order a live file still holds after a delete', () => {
    // The bug: `files.length` on 0..5 minus the file at 2 gives 5 — the order the
    // last file still has. Both then sort as equals and the run order stops
    // being deterministic.
    const afterDelete = [{ order: 0 }, { order: 1 }, { order: 3 }, { order: 4 }, { order: 5 }]
    expect(afterDelete).toHaveLength(5)
    expect(nextEtlOrder(afterDelete)).toBe(6)
  })

  it('starts at 0 on an empty pipeline', () => {
    expect(nextEtlOrder([])).toBe(0)
  })

  it('stays above the generated scripts, which sit at negative orders', () => {
    // EtlVocabularyTab writes mapping/ at -2 and the vocabulary script at -1 so
    // they run before the user's scripts; a new file must not land among them.
    expect(nextEtlOrder([{ order: -2 }, { order: -1 }])).toBe(0)
  })
})


describe('etlLanguageLabel', () => {
  it('writes the acronyms and names properly', () => {
    // "Language sql" in a sidebar reads like a bug.
    expect(etlLanguageLabel('sql')).toBe('SQL')
    expect(etlLanguageLabel('python')).toBe('Python')
    expect(etlLanguageLabel('r')).toBe('R')
    expect(etlLanguageLabel('markdown')).toBe('Markdown')
  })

  it('capitalises anything it does not know, rather than dropping it', () => {
    expect(etlLanguageLabel('julia')).toBe('Julia')
  })

  it('shows a dash when there is no language', () => {
    expect(etlLanguageLabel(undefined)).toBe('—')
  })
})
