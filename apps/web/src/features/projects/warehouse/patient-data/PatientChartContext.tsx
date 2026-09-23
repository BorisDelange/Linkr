import { createContext, useContext } from 'react'
import type { SchemaMapping } from '@/types/schema-mapping'

interface PatientChartContextValue {
  /** The key selection is stored under: the project's uid, or
   *  `databaseBoardKey(id)` for a database's own board. */
  projectUid: string
  /** The board being viewed — its settings (collection, sync…) hang off it. */
  boardId: string | undefined
  dataSourceId: string | undefined
  schemaMapping: SchemaMapping | undefined
  /** Permission check for a board outside a project, which answers to the
   *  database's workspace role instead. Omitted: the project role. */
  can?: (permission: string) => boolean
  /** False where R/Python widgets cannot run: in server mode code runs in a
   *  project's session, and a database's board has no project. */
  codeWidgets?: boolean
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
