import { useEffect } from 'react'
import { useAppStore } from '@/stores/app-store'
import { useDataSourceStore } from '@/stores/data-source-store'
import { reviewMappingSql } from './mapping-sql-review'

/** Mounted once in server mode: the open project's databases ask on their own, so
 *  the pages that read them need not. A declined text does not ask again here (the
 *  Mapping tab offers the review). */
export function MappingSqlAcceptance() {
  const projectUid = useAppStore((s) => s.activeProjectUid)
  const linkedIds = useAppStore((s) => s._projectsRaw.find((p) => p.uid === projectUid)?.linkedDataSourceIds)
  const dataSources = useDataSourceStore((s) => s.dataSources)

  useEffect(() => {
    for (const ds of dataSources) {
      if (linkedIds?.includes(ds.id) && ds.unacceptedFreeSql?.length) void reviewMappingSql(ds)
    }
  }, [dataSources, linkedIds])

  return null
}
