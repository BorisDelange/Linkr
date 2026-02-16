import { createContext, useContext } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'

interface PatientChartContextValue {
  projectUid: string
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
}

export const PatientChartContext = createContext<PatientChartContextValue>({
  projectUid: '',
  dataSourceId: undefined,
  schemaMapping: undefined,
})

export function usePatientChartContext() {
  return useContext(PatientChartContext)
}
