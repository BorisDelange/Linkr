import { createContext, useContext, useEffect } from 'react'
import type { ExportTable } from '@/lib/table-export'

/**
 * How an analysis publishes its tabular form to the shell's Export menu.
 *
 * A context rather than a module-level ref: the shell renders the component but
 * does not know what it produced, and the component sits several layers down.
 * A shared singleton made every analysis write to the same slot, so a table
 * published by one leaked into the Export menu of the next — offering "Copy as
 * LaTeX" on a plugin that has no table, and copying the wrong one.
 *
 * A chart simply never publishes, and the table entries stay hidden.
 */
export const AnalysisTableContext = createContext<{
  publish: (getTable: (() => ExportTable | null) | null) => void
} | null>(null)

/**
 * Publish this analysis's table for as long as the component is mounted.
 *
 * Pass `null` when there is nothing to export yet (still loading, misconfigured)
 * — that CLEARS the slot rather than leaving the previous analysis's table in
 * place, which is the bug this hook exists to make impossible.
 */
export function usePublishAnalysisTable(
  getTable: (() => ExportTable | null) | null,
  deps: React.DependencyList,
) {
  const ctx = useContext(AnalysisTableContext)
  useEffect(() => {
    ctx?.publish(getTable)
    return () => ctx?.publish(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, ...deps])
}
