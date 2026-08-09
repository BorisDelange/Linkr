import { describe, expect, it } from 'vitest'
import {
  compareEtlFilesByName,
  inferEtlLanguage,
  safeEtlFileName,
  uniqueEtlFileName,
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
