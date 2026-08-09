import { describe, expect, it } from 'vitest'
import { inferEtlLanguage, safeEtlFileName, uniqueEtlFileName } from './etl-file-language'

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
