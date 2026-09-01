/**
 * Sequencing rules for running a notebook's cells.
 *
 * Kept out of the component so the rules are testable on their own: the
 * component owns the kernel calls and the React state, this owns the decisions.
 */
import type { RmdCell } from '@/lib/rmd-parser'

/** Cells a Run all / Run above executes: code and markdown, blanks skipped. */
export function runnableCells(cells: RmdCell[]): RmdCell[] {
  return cells.filter(
    (c) => (c.type === 'code' || c.type === 'markdown') && c.content.trim() !== '',
  )
}

/**
 * Did this run fail?
 *
 * NOT `!!stderr`: R writes warnings and messages to stderr on runs that
 * succeeded, so a stderr-based rule would stop a Run all at the first warning
 * and paint it red. The engines report the verdict explicitly in `failed`.
 */
export function outputFailed(output: { failed?: boolean } | null | undefined): boolean {
  return output?.failed === true
}

export interface SequenceResult {
  /** Cells whose code was actually executed, in order. */
  ran: string[]
  /** True when every cell ran; false when a failure or an abort cut it short. */
  completed: boolean
}

/**
 * Run `cells` in order, stopping at the first failure or abort.
 *
 * A notebook is a chain: once a cell has raised, the ones below it run against
 * state it never produced, so they either fail in a way that hides the real
 * cause or — worse — succeed against stale values from an earlier run.
 *
 * `runOne` returns whether the cell succeeded; markdown cells are previewed via
 * `preview` and never stop the sequence.
 */
export async function runCellSequence(
  cells: RmdCell[],
  runOne: (cell: RmdCell) => Promise<boolean>,
  preview: (cell: RmdCell) => void,
  isAborted: () => boolean = () => false,
): Promise<SequenceResult> {
  const ran: string[] = []
  for (const cell of cells) {
    if (isAborted()) return { ran, completed: false }
    if (cell.type !== 'code') {
      preview(cell)
      continue
    }
    ran.push(cell.id)
    if (!(await runOne(cell))) return { ran, completed: false }
  }
  return { ran, completed: true }
}
