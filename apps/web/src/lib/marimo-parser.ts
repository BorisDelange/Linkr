/**
 * Parse marimo .py notebook files into cells and serialize back.
 *
 * Marimo format:
 *   import marimo
 *   app = marimo.App()
 *
 *   @app.cell
 *   def _(mo):
 *       x = 1
 *       return (x,)
 *
 *   if __name__ == "__main__":
 *       app.run()
 */

export interface MarimoCell {
  id: string
  name: string       // function name ("_" for anonymous)
  code: string       // body of the function (dedented)
  hideCode?: boolean  // @app.cell(hide_code=True)
}

let cellCounter = 0

/**
 * Parse a marimo .py file into an array of cells.
 */
export function parseMarimoFile(source: string): MarimoCell[] {
  const cells: MarimoCell[] = []

  // Match @app.cell or @app.cell(...) followed by def name(args):
  const cellPattern = /@app\.cell(?:\([^)]*\))?\s*\ndef\s+(\w+)\s*\([^)]*\):\s*\n/g

  let match: RegExpExecArray | null
  const cellStarts: { index: number; name: string; decoratorStart: number; bodyStart: number; hideCode: boolean }[] = []

  while ((match = cellPattern.exec(source)) !== null) {
    // Find the start of the decorator
    const decoratorIdx = source.lastIndexOf('@app.cell', match.index)
    const decoratorText = source.slice(decoratorIdx, match.index + match[0].length)
    const hideCode = decoratorText.includes('hide_code=True') || decoratorText.includes('hide_code = True')

    cellStarts.push({
      index: decoratorIdx,
      name: match[1],
      decoratorStart: decoratorIdx,
      bodyStart: match.index + match[0].length,
      hideCode,
    })
  }

  for (let i = 0; i < cellStarts.length; i++) {
    const start = cellStarts[i]
    const bodyStart = start.bodyStart

    // Find end of this cell: either the next @app.cell decorator, or `if __name__`, or EOF
    let bodyEnd: number
    if (i + 1 < cellStarts.length) {
      bodyEnd = cellStarts[i + 1].decoratorStart
    } else {
      // Look for `if __name__` block
      const ifMainIdx = source.indexOf('if __name__', bodyStart)
      bodyEnd = ifMainIdx !== -1 ? ifMainIdx : source.length
    }

    // Extract body and dedent (cells are indented by 4 spaces)
    const rawBody = source.slice(bodyStart, bodyEnd).replace(/\n\n$/, '\n')
    const lines = rawBody.split('\n')

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop()
    }

    // Dedent: remove 4-space indent from each line
    const dedented = lines.map((line) => {
      if (line.trim() === '') return ''
      return line.startsWith('    ') ? line.slice(4) : line
    }).join('\n')

    // Strip trailing `return (...)` statement
    const code = dedented.replace(/\nreturn\s+\(.*\)\s*$/, '').trimEnd()

    cells.push({
      id: `marimo-cell-${cellCounter++}`,
      name: start.name,
      code,
      hideCode: start.hideCode,
    })
  }

  return cells
}

/**
 * Serialize cells back to a marimo .py file.
 */
export function serializeMarimoFile(cells: MarimoCell[]): string {
  const lines: string[] = [
    'import marimo',
    '',
    'app = marimo.App()',
    '',
  ]

  for (const cell of cells) {
    // Determine return variables from assignments at top indent level
    const returns = extractReturnVars(cell.code)
    // Determine references (params) — we leave this to marimo's own analysis
    // Just use _ for function name and no params for simplicity
    const decorator = cell.hideCode ? '@app.cell(hide_code=True)' : '@app.cell'
    const funcName = cell.name || '_'

    lines.push(decorator)
    lines.push(`def ${funcName}():`)

    // Indent the code by 4 spaces
    const codeLines = cell.code.split('\n')
    for (const codeLine of codeLines) {
      lines.push(codeLine.trim() === '' ? '' : `    ${codeLine}`)
    }

    // Add return statement if there are variables to return
    if (returns.length > 0) {
      lines.push(`    return (${returns.join(', ')},)`)
    }

    lines.push('')
    lines.push('')
  }

  lines.push('if __name__ == "__main__":')
  lines.push('    app.run()')
  lines.push('')

  return lines.join('\n')
}

/**
 * Extract variable names that are assigned at the top level of a cell.
 * Simple heuristic: look for `name = ...` patterns.
 */
function extractReturnVars(code: string): string[] {
  const vars = new Set<string>()
  for (const line of code.split('\n')) {
    // Skip indented lines (inside if/for/etc)
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    // Match simple assignment: `name = ...` or `name: type = ...`
    const match = line.match(/^(\w+)\s*(?::\s*\w+)?\s*=/)
    if (match && !match[1].startsWith('_') && match[1] !== 'import') {
      vars.add(match[1])
    }
  }
  return [...vars]
}
