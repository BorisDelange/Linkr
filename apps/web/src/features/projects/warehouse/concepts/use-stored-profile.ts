import { useEffect, useState } from 'react'
import { profileStore } from '@/lib/concept-profiles/profile-store-backend'
import type { StoredProfile } from '@/lib/concept-profiles/profile-store'

/**
 * The database's stored profile of the selected concept, or null. `version`
 * reads it again: bumped when a profiling run stops.
 */
export function useStoredProfile(
  dataSourceId: string | undefined,
  dictKey: string | null | undefined,
  conceptId: number | null,
  version = 0,
): StoredProfile | null {
  const [found, setFound] = useState<{ key: string; profile: StoredProfile | null } | null>(null)
  const key = dataSourceId && dictKey && conceptId != null ? `${dataSourceId}|${dictKey}|${conceptId}|${version}` : null
  useEffect(() => {
    if (!key || !dataSourceId || !dictKey || conceptId == null) return
    let cancelled = false
    profileStore().read(dataSourceId, dictKey, [conceptId])
      .then((rows) => { if (!cancelled) setFound({ key, profile: rows[0] ?? null }) })
      .catch(() => { if (!cancelled) setFound({ key, profile: null }) })
    return () => { cancelled = true }
  }, [key, dataSourceId, dictKey, conceptId])
  return found?.key === key ? found.profile : null
}
