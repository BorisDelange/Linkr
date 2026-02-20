/**
 * Parser & serializer for R Markdown (.Rmd) and Quarto (.qmd) files.
 *
 * Splits a document into typed cells: yaml front-matter, markdown sections,
 * and code chunks. Supports lossless round-trip: unedited cells preserve
 * their original text exactly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RmdCellType = 'yaml' | 'markdown' | 'code'

export interface RmdCell {
  id: string
  type: RmdCellType
  /** Editable content: code body (without fences), markdown text, or yaml body (without ---). */
  content: string
  /** For code cells: language extracted from chunk header (r, python, sql, bash, etc.) */
  language?: string
  /** For code cells: chunk label/name if present */
  chunkLabel?: string
  /** For code cells: raw options string after label (e.g. "echo=FALSE, fig.width=10") */
  chunkOptions?: string
  /** Original chunk header line for lossless serialization (e.g. "```{r setup, echo=FALSE}") */
  rawHeader?: string
  /**
   * Raw original text of this cell including delimiters.
   * Used for lossless round-trip when the cell hasn't been edited.
   */
  rawText?: string
  /** Set to true when the user edits the cell content (invalidates rawText). */
  dirty?: boolean
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

let _idCounter = 0

function nextId(): string {
  return `rmd-cell-${_idCounter++}`
}

/** Reset ID counter (useful for tests). */
export function resetIdCounter(): void {
  _idCounter = 0
}

/**
 * Parse an Rmd/Qmd file into a list of cells.
 *
 * The algorithm scans line-by-line to correctly handle:
 * - YAML front-matter at the top (delimited by ---)
 * - Code chunks delimited by ```{lang ...} ... ```
 * - Markdown text in between
 */
export function parseRmdFile(source: string): RmdCell[] {
  const cells: RmdCell[] = []
  const lines = source.split('\n')
  let cursor = 0

  // -------------------------------------------------------------------------
  // 1. YAML front-matter (only at the very start)
  // -------------------------------------------------------------------------
  if (lines[0]?.trimEnd() === '---') {
    let endIdx = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimEnd() === '---') {
        endIdx = i
        break
      }
    }
    if (endIdx > 0) {
      const yamlBody = lines.slice(1, endIdx).join('\n')
      const rawText = lines.slice(0, endIdx + 1).join('\n')
      cells.push({
        id: nextId(),
        type: 'yaml',
        content: yamlBody,
        rawText,
      })
      cursor = endIdx + 1
    }
  }

  // -------------------------------------------------------------------------
  // 2. Scan remaining lines for code chunks and markdown
  // -------------------------------------------------------------------------
  const chunkHeaderRe = /^```\{(\w+)(?:\s+(.*))?\}\s*$/
  let mdStart = cursor

  while (cursor < lines.length) {
    const headerMatch = lines[cursor].match(chunkHeaderRe)

    if (headerMatch) {
      // Flush accumulated markdown before this chunk
      if (cursor > mdStart) {
        const mdText = lines.slice(mdStart, cursor).join('\n')
        if (mdText.trim()) {
          cells.push({
            id: nextId(),
            type: 'markdown',
            content: mdText,
            rawText: mdText,
          })
        }
      }

      // Find the closing ```
      const chunkStart = cursor
      let chunkEnd = -1
      for (let i = cursor + 1; i < lines.length; i++) {
        if (/^```\s*$/.test(lines[i])) {
          chunkEnd = i
          break
        }
      }

      if (chunkEnd === -1) {
        // Unclosed chunk — treat everything to EOF as code
        chunkEnd = lines.length - 1
      }

      const language = headerMatch[1]
      const optionsRaw = headerMatch[2]?.trim() ?? ''
      const { label, options } = parseChunkHeader(optionsRaw)
      const codeBody = lines.slice(chunkStart + 1, chunkEnd).join('\n')
      const rawText = lines.slice(chunkStart, chunkEnd + 1).join('\n')

      cells.push({
        id: nextId(),
        type: 'code',
        content: codeBody,
        language,
        chunkLabel: label || undefined,
        chunkOptions: options || undefined,
        rawHeader: lines[chunkStart],
        rawText,
      })

      cursor = chunkEnd + 1
      mdStart = cursor
    } else {
      cursor++
    }
  }

  // Flush trailing markdown
  if (mdStart < lines.length) {
    const mdText = lines.slice(mdStart).join('\n')
    if (mdText.trim()) {
      cells.push({
        id: nextId(),
        type: 'markdown',
        content: mdText,
        rawText: mdText,
      })
    }
  }

  return cells
}

/**
 * Parse the options portion of a chunk header.
 * Input example: "setup, echo=FALSE, fig.width=10"
 * Returns: { label: "setup", options: "echo=FALSE, fig.width=10" }
 */
function parseChunkHeader(raw: string): { label: string; options: string } {
  if (!raw) return { label: '', options: '' }

  const parts = raw.split(',').map((s) => s.trim())
  // First part is a label if it doesn't contain '='
  if (parts[0] && !parts[0].includes('=')) {
    return {
      label: parts[0],
      options: parts.slice(1).map((s) => s.trim()).filter(Boolean).join(', '),
    }
  }
  return { label: '', options: raw }
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize cells back to an Rmd/Qmd file string.
 *
 * - Unedited cells (dirty !== true) use rawText for lossless round-trip.
 * - Edited cells are reconstructed from their structured fields.
 */
export function serializeRmdFile(cells: RmdCell[]): string {
  return cells
    .map((cell) => {
      // Lossless path: use original text if cell wasn't edited
      if (!cell.dirty && cell.rawText !== undefined) {
        return cell.rawText
      }

      if (cell.type === 'yaml') {
        return `---\n${cell.content}\n---`
      }

      if (cell.type === 'markdown') {
        return cell.content
      }

      // Code cell — reconstruct from fields
      const lang = cell.language ?? 'r'
      const headerParts: string[] = []
      if (cell.chunkLabel) headerParts.push(cell.chunkLabel)
      if (cell.chunkOptions) headerParts.push(cell.chunkOptions)
      const headerSuffix = headerParts.length > 0 ? ` ${headerParts.join(', ')}` : ''
      return `\`\`\`{${lang}${headerSuffix}}\n${cell.content}\n\`\`\``
    })
    .join('\n')
}
