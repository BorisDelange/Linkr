export type StringCallLanguage = 'r' | 'python'

/** The string literal the cursor sits in, when it is the argument of a call whose
 *  content the editor can complete: a database identifier or a SQL query. */
export interface StringCall {
  fn: 'connect' | 'sql_query'
  /** Offset of the string's first content character (after the opening quote). */
  start: number
  /** Offset of the closing quote — or of the end of the text, or of the line for
   *  an unterminated single-line Python string. */
  end: number
}

// The call up to where its first argument starts. A named argument (`alias = `)
// still counts.
const CALL: Record<StringCallLanguage, string> = {
  r: String.raw`(?<![\w.])(?:linkr::)?(linkr_connect|sql_query)\s*\(\s*(?:[A-Za-z.][\w.]*\s*=\s*)?`,
  python: String.raw`(?<![\w.])(linkr\.connect|sql_query)\s*\(\s*(?:[A-Za-z_]\w*\s*=\s*)?`,
}
// Text before an opening quote; Python's string prefixes (`f"…"`) count, for an
// f-string query.
const CALLEE: Record<StringCallLanguage, RegExp> = {
  r: new RegExp(`${CALL.r}$`),
  python: new RegExp(`${CALL.python}[rRfFuU]{0,2}$`),
}
// Text before the cursor, with the argument not started yet (or a bare word).
const CALL_OPEN: Record<StringCallLanguage, RegExp> = {
  r: new RegExp(`${CALL.r}(\\w*)$`),
  python: new RegExp(`${CALL.python}(\\w*)$`),
}

const fnOf = (callee: string): StringCall['fn'] => (callee === 'sql_query' ? 'sql_query' : 'connect')

/**
 * The call whose first argument the cursor is about to write, before any quote:
 * `linkr_connect(|` or `linkr_connect(mi|`. `word` is what was typed so far.
 */
export function callOpenAt(textBefore: string, language: StringCallLanguage): { fn: StringCall['fn']; word: string } | null {
  const m = CALL_OPEN[language].exec(textBefore)
  return m ? { fn: fnOf(m[1]), word: m[2] } : null
}

/**
 * Finds the string literal containing `cursor` and the call it is passed to.
 * Scans `text` from its start, so the caller passes a window that begins outside
 * any string; a string opened before the window is missed.
 */
export function stringCallAt(text: string, cursor: number, language: StringCallLanguage): StringCall | null {
  let quote: string | null = null
  let quoteAt = 0
  let i = 0
  while (i < cursor) {
    const c = text[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (quote.length === 1 && c === '\n' && language === 'python') { quote = null; i++; continue }
      if (text.startsWith(quote, i)) { i += quote.length; quote = null; continue }
      i++
      continue
    }
    if (c === '#') {
      const nl = text.indexOf('\n', i)
      if (nl === -1 || nl >= cursor) return null
      i = nl + 1
      continue
    }
    if (c === '"' || c === "'") {
      quote = language === 'python' && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c
      quoteAt = i
      i += quote.length
      continue
    }
    i++
  }
  // `i` overshoots `cursor` when an escape or a closing triple quote straddles it.
  if (!quote || i > cursor) return null

  const m = CALLEE[language].exec(text.slice(0, quoteAt))
  if (!m) return null
  const start = quoteAt + quote.length
  return { fn: fnOf(m[1]), start, end: closingQuote(text, cursor, quote, language) }
}

function closingQuote(text: string, from: number, quote: string, language: StringCallLanguage): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (quote.length === 1 && c === '\n' && language === 'python') return i
    if (text.startsWith(quote, i)) return i
  }
  return text.length
}
