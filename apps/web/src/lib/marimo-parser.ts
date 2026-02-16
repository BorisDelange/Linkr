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

    // Extract exports from the trailing return statement.
    // Handles: return (x, y,)  |  return x, y  |  return  |  bare return
    // The return may span multiple lines when using parens: return (\n  x,\n)
    let exports: string[] = []
    let code: string

    // Try multi-line return with parens: return (\n ...\n)
    const multiLineReturn = dedented.match(/(?:^|\n)return\s*\(([^)]*)\)\s*$/)
    // Try single-line return without parens: return x, y
    const singleLineReturn = !multiLineReturn && dedented.match(/(?:^|\n)return\s+([^(\s][^\n]*?)\s*$/)
    // Try bare return (no value)
    const bareReturn = !multiLineReturn && !singleLineReturn && dedented.match(/(?:^|\n)return\s*$/)

    if (multiLineReturn) {
      exports = multiLineReturn[1].split(',').map((s) => s.trim()).filter(Boolean)
      code = dedented.slice(0, multiLineReturn.index === 0 ? 0 : multiLineReturn.index).trimEnd()
    } else if (singleLineReturn) {
      exports = singleLineReturn[1].split(',').map((s) => s.trim()).filter(Boolean)
      code = dedented.slice(0, singleLineReturn.index === 0 ? 0 : singleLineReturn.index).trimEnd()
    } else if (bareReturn) {
      exports = []
      code = dedented.slice(0, bareReturn.index === 0 ? 0 : bareReturn.index).trimEnd()
    } else {
      code = dedented.trimEnd()
    }

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

// Python builtins and common names to exclude from param inference
const PYTHON_BUILTINS = new Set([
  'print', 'len', 'range', 'int', 'float', 'str', 'bool', 'list', 'dict',
  'set', 'tuple', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr',
  'setattr', 'delattr', 'super', 'property', 'classmethod', 'staticmethod',
  'abs', 'all', 'any', 'bin', 'chr', 'dir', 'divmod', 'enumerate', 'eval',
  'exec', 'filter', 'format', 'frozenset', 'globals', 'hash', 'hex', 'id',
  'input', 'iter', 'map', 'max', 'min', 'next', 'object', 'oct', 'open',
  'ord', 'pow', 'repr', 'reversed', 'round', 'slice', 'sorted', 'sum',
  'vars', 'zip', 'None', 'True', 'False', 'Exception', 'ValueError',
  'TypeError', 'KeyError', 'IndexError', 'RuntimeError', 'StopIteration',
  'NotImplementedError', 'AttributeError', 'ImportError', 'OSError',
  'FileNotFoundError', 'ZeroDivisionError', 'AssertionError',
  // Common imports that are always available in Pyodide
  'np', 'pd', 'plt', 'matplotlib', 'numpy', 'pandas', 'os', 'sys', 'io',
  'json', 'math', 're', 'datetime', 'collections', 'itertools', 'functools',
  'pathlib', 'csv', 'time', 'random', 'copy', 'typing',
  // Our bridge function
  'sql_query',
])

/**
 * Extract names that are defined locally in a cell (assignments, imports, for-vars, function/class defs).
 */
function extractLocalDefs(code: string): Set<string> {
  const defs = new Set<string>()
  for (const line of code.split('\n')) {
    const trimmed = line.trimStart()
    // Assignment: name = ... or name: type = ...
    const assignMatch = trimmed.match(/^(\w+)\s*(?::\s*\w[\w\[\], |]*?)?\s*=/)
    if (assignMatch) defs.add(assignMatch[1])
    // for var in ...:
    const forMatch = trimmed.match(/^for\s+(\w+)/)
    if (forMatch) defs.add(forMatch[1])
    // def funcname(...)
    const defMatch = trimmed.match(/^def\s+(\w+)/)
    if (defMatch) defs.add(defMatch[1])
    // class ClassName
    const classMatch = trimmed.match(/^class\s+(\w+)/)
    if (classMatch) defs.add(classMatch[1])
    // import name / from ... import name
    const importMatch = trimmed.match(/^import\s+(\w+)/)
    if (importMatch) defs.add(importMatch[1])
    const fromImportMatch = trimmed.match(/^from\s+\S+\s+import\s+(.+)/)
    if (fromImportMatch) {
      for (const part of fromImportMatch[1].split(',')) {
        const asMatch = part.trim().match(/(\w+)(?:\s+as\s+(\w+))?/)
        if (asMatch) defs.add(asMatch[2] || asMatch[1])
      }
    }
    // with ... as name:
    const withMatch = trimmed.match(/^with\s+.+\s+as\s+(\w+)/)
    if (withMatch) defs.add(withMatch[1])
  }
  return defs
}

/**
 * Extract bare names used in code (identifiers that look like variable references).
 * This is a rough heuristic — it finds all \b\w+\b tokens that could be variable names.
 */
function extractUsedNames(code: string): Set<string> {
  const names = new Set<string>()
  // Remove comments and string literals to avoid false positives
  const cleaned = code
    .replace(/#.*$/gm, '')            // remove comments
    .replace(/"""[\s\S]*?"""/g, '')   // remove triple-quoted strings
    .replace(/'''[\s\S]*?'''/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '') // remove double-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, '') // remove single-quoted strings

  // Find all identifiers (word boundary ensures we get standalone names)
  const identRe = /\b([a-zA-Z_]\w*)\b/g
  let m: RegExpExecArray | null
  while ((m = identRe.exec(cleaned)) !== null) {
    names.add(m[1])
  }
  return names
}

/**
 * Infer the params (dependencies) of a cell by finding names that are:
 * 1. Used in the code
 * 2. Not defined locally in the cell
 * 3. Not Python builtins
 * 4. Exported by another cell (i.e., available in the notebook namespace)
 */
export function inferCellParams(code: string, allExports: Set<string>): string[] {
  const used = extractUsedNames(code)
  const localDefs = extractLocalDefs(code)

  const params: string[] = []
  for (const name of used) {
    if (localDefs.has(name)) continue
    if (PYTHON_BUILTINS.has(name)) continue
    if (!allExports.has(name)) continue
    params.push(name)
  }
  return params.sort()
}

/**
 * Recompute params for all cells based on the full set of exports across the notebook.
 * This is the main function to call after any cell edit.
 */
export function recomputeAllParams(cells: MarimoCell[]): MarimoCell[] {
  // Gather all exports across all cells
  const allExports = new Set<string>()
  for (const cell of cells) {
    for (const v of cell.exports) {
      allExports.add(v)
    }
  }

  return cells.map((cell) => {
    const params = inferCellParams(cell.code, allExports)
    // Only update if params actually changed (avoid unnecessary rerenders)
    if (params.length === cell.params.length && params.every((p, i) => p === cell.params[i])) {
      return cell
    }
    return { ...cell, params }
  })
}
