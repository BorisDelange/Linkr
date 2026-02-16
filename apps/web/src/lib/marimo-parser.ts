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
  name: string          // function name ("_" for anonymous)
  code: string          // body of the function (dedented, return stripped)
  hideCode?: boolean    // @app.cell(hide_code=True)
  params: string[]      // function parameters = what this cell reads from other cells
  exports: string[]     // return tuple variables = what this cell produces
}

let cellCounter = 0

/**
 * Parse a marimo .py file into an array of cells.
 */
export function parseMarimoFile(source: string): MarimoCell[] {
  const cells: MarimoCell[] = []

  // Match @app.cell or @app.cell(...) followed by def name(args):
  // Capture group 1 = function name, group 2 = args string
  const cellPattern = /@app\.cell(?:\([^)]*\))?\s*\ndef\s+(\w+)\s*\(([^)]*)\):\s*\n/g

  let match: RegExpExecArray | null
  const cellStarts: {
    index: number
    name: string
    params: string[]
    decoratorStart: number
    bodyStart: number
    hideCode: boolean
  }[] = []

  while ((match = cellPattern.exec(source)) !== null) {
    // Find the start of the decorator
    const decoratorIdx = source.lastIndexOf('@app.cell', match.index)
    const decoratorText = source.slice(decoratorIdx, match.index + match[0].length)
    const hideCode = decoratorText.includes('hide_code=True') || decoratorText.includes('hide_code = True')

    // Parse function parameters
    const params = match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    cellStarts.push({
      index: decoratorIdx,
      name: match[1],
      params,
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

    // Extract exports from return tuple before stripping it
    const returnMatch = dedented.match(/\nreturn\s+\(([^)]*)\)\s*$/)
    const exports = returnMatch
      ? returnMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
      : []

    // Strip trailing `return (...)` statement from code
    const code = dedented.replace(/\nreturn\s+\(.*\)\s*$/, '').trimEnd()

    cells.push({
      id: `marimo-cell-${cellCounter++}`,
      name: start.name,
      code,
      hideCode: start.hideCode,
      params: start.params,
      exports,
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
    // Use explicit exports if available, otherwise infer from code
    const returns = cell.exports.length > 0 ? cell.exports : extractReturnVars(cell.code)
    const decorator = cell.hideCode ? '@app.cell(hide_code=True)' : '@app.cell'
    const funcName = cell.name || '_'
    const params = cell.params.join(', ')

    lines.push(decorator)
    lines.push(`def ${funcName}(${params}):`)

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
 * Used as fallback when cell.exports is empty (new cells).
 */
export function extractReturnVars(code: string): string[] {
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
