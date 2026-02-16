/**
 * Code generator registry.
 *
 * Each analysis type has a function that produces Python code
 * from the analysis config + column metadata.
 */

import type { DatasetColumn, DatasetAnalysisType } from '@/types'
import { generateTable1Code } from './table1'

export type CodeGenerator = (
  config: Record<string, unknown>,
  columns: DatasetColumn[],
) => string

export const codeGenerators: Partial<Record<DatasetAnalysisType, CodeGenerator>> = {
  table1: generateTable1Code,
  // Phase 2: distribution, summary, correlation, crosstab generators
}

/**
 * Generate Python code for a given analysis type and config.
 * Returns null if the type has no generator (e.g. 'custom').
 */
export function generateAnalysisCode(
  type: DatasetAnalysisType,
  config: Record<string, unknown>,
  columns: DatasetColumn[],
): string | null {
  const generator = codeGenerators[type]
  if (!generator) return null
  return generator(config, columns)
}
