import { useEffect, useState } from 'react'
import { fetchDerivePlan, type DeriveScope } from '@/lib/api/data-sources'
import { droppedOnRebuild } from '@/lib/cohort-derive'
import type { CohortLevel } from '@/types'

interface RebuildSubject {
  parentId: string | undefined
  level: CohortLevel
  scope?: DeriveScope
  target: { dataSourceId: string; schemaName?: string | null }
  /** The tables its last build copied on the opt-in, as the server recorded them. */
  copiedUnproven?: string[]
}

/**
 * What a rebuild leaves out of its target, while its confirmation is open: the
 * tables the last build copied on the opt-in when it recorded them, else (a build
 * from before that record) those the target holds that the plan no longer copies.
 */
export function useRebuildDropped(open: boolean, subject: RebuildSubject | null): { tables: string[]; recorded: boolean } {
  const recorded = subject?.copiedUnproven ?? []
  const [fetched, setFetched] = useState<{ key: string; tables: string[] } | null>(null)
  const key = subject ? JSON.stringify([subject.parentId, subject.level, subject.scope, subject.target]) : ''
  const needsPlan = open && !!subject?.parentId && recorded.length === 0

  useEffect(() => {
    if (!needsPlan) return
    const [parentId, level, scope, target] = JSON.parse(key) as [string, CohortLevel, DeriveScope | undefined, RebuildSubject['target']]
    let live = true
    fetchDerivePlan(parentId, level, scope, target)
      .then((plan) => { if (live) setFetched({ key, tables: droppedOnRebuild(plan) }) })
      .catch(() => { if (live) setFetched({ key, tables: [] }) })
    return () => { live = false }
  }, [needsPlan, key])

  if (recorded.length > 0) return { tables: recorded, recorded: true }
  return { tables: needsPlan && fetched?.key === key ? fetched.tables : [], recorded: false }
}
