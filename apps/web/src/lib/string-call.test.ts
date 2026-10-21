import { describe, expect, it } from 'vitest'
import { callOpenAt, stringCallAt, type StringCallLanguage } from './string-call'

/** `|` marks the cursor. */
function at(src: string, language: StringCallLanguage) {
  const cursor = src.indexOf('|')
  const text = src.slice(0, cursor) + src.slice(cursor + 1)
  const call = stringCallAt(text, cursor, language)
  return call && { fn: call.fn, content: text.slice(call.start, call.end) }
}

describe('stringCallAt', () => {
  it('finds the identifier string of linkr_connect in R', () => {
    expect(at('con <- linkr_connect("mim|")', 'r')).toEqual({ fn: 'connect', content: 'mim' })
    expect(at('con <- linkr::linkr_connect(alias = \'|\')', 'r')).toEqual({ fn: 'connect', content: '' })
  })

  it('finds linkr.connect in Python, but not another library\'s connect', () => {
    expect(at('con = linkr.connect("|")', 'python')).toEqual({ fn: 'connect', content: '' })
    expect(at('con = duckdb.connect("|")', 'python')).toBeNull()
    expect(at('con = connect("|")', 'python')).toBeNull()
  })

  it('returns the whole query of sql_query, past the cursor', () => {
    expect(at('df <- sql_query("SELECT | FROM person")', 'r'))
      .toEqual({ fn: 'sql_query', content: 'SELECT  FROM person' })
  })

  it('follows an R string across lines', () => {
    expect(at('x <- sql_query("\n  SELECT *\n  FROM |\n")', 'r'))
      .toEqual({ fn: 'sql_query', content: '\n  SELECT *\n  FROM \n' })
  })

  it('handles Python triple-quoted and f-strings', () => {
    expect(at('df = sql_query("""\nSELECT * FROM |\n""")', 'python'))
      .toEqual({ fn: 'sql_query', content: '\nSELECT * FROM \n' })
    expect(at('df = sql_query(f"SELECT * FROM {t} WHERE |")', 'python'))
      .toEqual({ fn: 'sql_query', content: 'SELECT * FROM {t} WHERE ' })
  })

  it('is not fooled by escaped quotes', () => {
    expect(at('sql_query("SELECT \\"a|\\" FROM t")', 'r'))
      .toEqual({ fn: 'sql_query', content: 'SELECT \\"a\\" FROM t' })
  })

  it('ignores the cursor outside a string, or in another call\'s string', () => {
    expect(at('linkr_connect("a")|', 'r')).toBeNull()
    expect(at('print("|")', 'r')).toBeNull()
    expect(at('my_sql_query("|")', 'r')).toBeNull()
  })

  it('ignores quotes inside comments', () => {
    expect(at('# don\'t\nlinkr_connect("|")', 'r')).toEqual({ fn: 'connect', content: '' })
    expect(at('# linkr_connect("|', 'r')).toBeNull()
  })
})

describe('callOpenAt', () => {
  it('sees a call whose argument has not started', () => {
    expect(callOpenAt('con <- linkr_connect(', 'r')).toEqual({ fn: 'connect', word: '' })
    expect(callOpenAt('con <- linkr_connect(mi', 'r')).toEqual({ fn: 'connect', word: 'mi' })
    expect(callOpenAt('df = sql_query( ', 'python')).toEqual({ fn: 'sql_query', word: '' })
    expect(callOpenAt('con = linkr.connect(alias=', 'python')).toEqual({ fn: 'connect', word: '' })
  })

  it('ignores other calls and a started string', () => {
    expect(callOpenAt('duckdb.connect(', 'python')).toBeNull()
    expect(callOpenAt('linkr_connect("', 'r')).toBeNull()
    expect(callOpenAt('my_sql_query(', 'r')).toBeNull()
  })
})
