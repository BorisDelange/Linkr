import { useCallback, useEffect, useState } from 'react'

const KEY = 'linkr-concepts-database'

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * Which database the Concepts page reads, remembered per project.
 *
 * Concepts is a browsing screen with nothing of its own to persist — unlike a
 * patient board or a cohort, there is no entity to carry the choice. So it stays
 * a local preference: it follows the person, not the project, and is never
 * exported.
 */
export function useConceptsDatabase(projectUid: string | undefined) {
  const [dataSourceId, setDataSourceId] = useState<string | undefined>(
    () => (projectUid ? readAll()[projectUid] : undefined),
  )

  useEffect(() => {
    setDataSourceId(projectUid ? readAll()[projectUid] : undefined)
  }, [projectUid])

  const choose = useCallback(
    (id: string) => {
      setDataSourceId(id)
      if (!projectUid) return
      try {
        localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [projectUid]: id }))
      } catch {
        // A full or blocked store only costs the preference, not the page.
      }
    },
    [projectUid],
  )

  return [dataSourceId, choose] as const
}
