/**
 * Parser for Jupyter Notebook (.ipynb) files.
 * Converts the JSON format into typed structures for the IpynbViewer component.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpynbNotebook {
  metadata: {
    kernelspec?: { language?: string; display_name?: string }
    language_info?: { name?: string }
  }
  nbformat: number
  nbformat_minor: number
  cells: IpynbCell[]
}

export interface IpynbCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: IpynbOutput[]
}

export interface IpynbOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  /** stream only */
  name?: 'stdout' | 'stderr'
  /** stream only — normalized to string */
  text?: string
  /** execute_result / display_data — mime-type → content */
  data?: Record<string, string>
  metadata?: Record<string, unknown>
  execution_count?: number | null
  /** error only */
  ename?: string
  evalue?: string
  traceback?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize source/text: ipynb stores lines as string[] or string. */
function normalizeText(value: string | string[] | undefined): string {
  if (value === undefined) return ''
  return Array.isArray(value) ? value.join('') : value
}

/**
 * Normalize mime-bundle data fields.
 * Values can be string or string[] — normalize everything to string.
 */
function normalizeMimeData(
  data: Record<string, string | string[]> | undefined,
): Record<string, string> | undefined {
  if (!data) return undefined
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(data)) {
    out[key] = Array.isArray(val) ? val.join('') : val
  }
  return out
}

/** Strip ANSI escape codes from error traceback strings. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse a .ipynb JSON string into a typed IpynbNotebook. */
export function parseIpynbFile(jsonString: string): IpynbNotebook {
  const raw = JSON.parse(jsonString) as Record<string, unknown>

  const metadata = (raw.metadata ?? {}) as IpynbNotebook['metadata']
  const nbformat = (raw.nbformat ?? 4) as number
  const nbformat_minor = (raw.nbformat_minor ?? 0) as number

  // v3 format has worksheets[0].cells
  let rawCells: unknown[]
  if (nbformat < 4 && Array.isArray((raw as Record<string, unknown>).worksheets)) {
    const worksheets = (raw as Record<string, unknown>).worksheets as { cells?: unknown[] }[]
    rawCells = worksheets[0]?.cells ?? []
  } else {
    rawCells = (raw.cells ?? []) as unknown[]
  }

  const cells: IpynbCell[] = rawCells.map((rc) => {
    const c = rc as Record<string, unknown>
    const cell: IpynbCell = {
      cell_type: (c.cell_type as IpynbCell['cell_type']) ?? 'code',
      source: normalizeText(c.source as string | string[]),
      metadata: (c.metadata ?? {}) as Record<string, unknown>,
      execution_count: (c.execution_count as number | null) ?? null,
    }

    if (Array.isArray(c.outputs)) {
      cell.outputs = (c.outputs as Record<string, unknown>[]).map((ro) => {
        const output: IpynbOutput = {
          output_type: ro.output_type as IpynbOutput['output_type'],
        }

        if (output.output_type === 'stream') {
          output.name = (ro.name as 'stdout' | 'stderr') ?? 'stdout'
          output.text = normalizeText(ro.text as string | string[])
        } else if (
          output.output_type === 'execute_result' ||
          output.output_type === 'display_data'
        ) {
          output.data = normalizeMimeData(ro.data as Record<string, string | string[]>)
          output.metadata = (ro.metadata ?? {}) as Record<string, unknown>
          if (ro.execution_count !== undefined) {
            output.execution_count = ro.execution_count as number | null
          }
        } else if (output.output_type === 'error') {
          output.ename = (ro.ename as string) ?? 'Error'
          output.evalue = (ro.evalue as string) ?? ''
          output.traceback = ((ro.traceback ?? []) as string[]).map(stripAnsi)
        }

        return output
      })
    }

    return cell
  })

  return { metadata, nbformat, nbformat_minor, cells }
}

/**
 * Detect the primary language of a notebook from its metadata.
 * Falls back to 'python' if undetectable.
 */
export function getNotebookLanguage(notebook: IpynbNotebook): string {
  return (
    notebook.metadata.kernelspec?.language ??
    notebook.metadata.language_info?.name ??
    'python'
  )
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/** Split a string into Jupyter-style line array (each line ends with \n except the last). */
function toLineArray(text: string): string[] {
  if (!text) return ['']
  const lines = text.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line))
}

/** Serialize an IpynbNotebook back to a .ipynb JSON string. */
export function serializeIpynbFile(notebook: IpynbNotebook): string {
  const cells = notebook.cells.map((cell) => {
    const out: Record<string, unknown> = {
      cell_type: cell.cell_type,
      metadata: cell.metadata ?? {},
      source: toLineArray(cell.source),
    }
    if (cell.cell_type === 'code') {
      out.execution_count = cell.execution_count ?? null
      out.outputs = (cell.outputs ?? []).map((o) => {
        const so: Record<string, unknown> = { output_type: o.output_type }
        if (o.output_type === 'stream') {
          so.name = o.name ?? 'stdout'
          so.text = toLineArray(o.text ?? '')
        } else if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
          const data: Record<string, unknown> = {}
          if (o.data) {
            for (const [mime, val] of Object.entries(o.data)) {
              data[mime] = mime.startsWith('text/') ? toLineArray(val) : val
            }
          }
          so.data = data
          so.metadata = o.metadata ?? {}
          if (o.output_type === 'execute_result') so.execution_count = o.execution_count ?? null
        } else if (o.output_type === 'error') {
          so.ename = o.ename ?? 'Error'
          so.evalue = o.evalue ?? ''
          so.traceback = o.traceback ?? []
        }
        return so
      })
    }
    return out
  })

  return JSON.stringify({
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
    metadata: notebook.metadata,
    cells,
  }, null, 1) + '\n'
}

// ---------------------------------------------------------------------------
// ipynb ↔ RmdCell converters
// ---------------------------------------------------------------------------

import type { RmdCell } from '@/lib/rmd-parser'

/** Convert parsed ipynb cells to RmdCell[] for use in RmdNotebook. */
export function ipynbToRmdCells(notebook: IpynbNotebook): RmdCell[] {
  const language = getNotebookLanguage(notebook)
  return notebook.cells.map((cell, i) => {
    const base: RmdCell = {
      id: `ipynb-cell-${i}-${Date.now()}`,
      type: cell.cell_type === 'code' ? 'code' : 'markdown',
      content: cell.source,
      dirty: false,
    }
    if (cell.cell_type === 'code') {
      base.language = language
    }
    return base
  })
}

/** Convert RmdCell[] back to ipynb JSON string, preserving notebook metadata. */
export function rmdCellsToIpynb(cells: RmdCell[], metadata: IpynbNotebook['metadata']): string {
  const notebook: IpynbNotebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata,
    cells: cells.map((cell) => ({
      cell_type: cell.type === 'code' ? 'code' : 'markdown',
      source: cell.content,
      metadata: {},
      execution_count: cell.type === 'code' ? null : undefined,
      outputs: cell.type === 'code' ? [] : undefined,
    })),
  }
  return serializeIpynbFile(notebook)
}
