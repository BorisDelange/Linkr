import { createContext, useContext } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'

interface PatientChartContextValue {
  projectUid: string
  /** The board being viewed — its settings (collection, sync…) hang off it. */
  boardId: string | undefined
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
}

export const PatientChartContext = createContext<PatientChartContextValue>({
  projectUid: '',
  boardId: undefined,
  dataSourceId: undefined,
  schemaMapping: undefined,
})

export function usePatientChartContext() {
  return useContext(PatientChartContext)
}
