import { useMyWorkspaceRole } from '@/hooks/use-context-role'
import { isExternalEngine } from '@/lib/database-engines'
import { useDataSourceStore } from '@/stores/data-source-store'
import type { DatabaseConnectionConfig } from '@/types'

/**
 * Whether the server answers this user's statistics diagnosis (its own rule): a
 * file database's concept cache is shared, so it takes an edit right; an
 * external one's is the user's own.
 */
export function useCanDiagnoseConceptStats(dataSourceId: string | undefined): boolean {
  const canEdit = useMyWorkspaceRole().can('databases:write')
  const external = useDataSourceStore((s) =>
    isExternalEngine((s.dataSources.find((d) => d.id === dataSourceId)?.connectionConfig as DatabaseConnectionConfig | undefined)?.engine),
  )
  return canEdit || external
}
