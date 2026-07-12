import { create } from 'zustand'
import { apiRequest, isServerMode } from '@/lib/api-client'
import { useAppStore } from '@/stores/app-store'

export type VisitEntityType = 'workspace' | 'project' | 'mapping-project'

interface EntityVisit {
  entityType: VisitEntityType
  entityId: string
  visitedAt: string
}

interface VisitState {
  /** `${entityType}:${entityId}` → ISO timestamp of this user's last visit. */
  lastVisited: Record<string, string>
  loaded: boolean

  loadVisits: () => Promise<void>
  recordVisit: (entityType: VisitEntityType, entityId: string) => void
}

const key = (type: VisitEntityType, id: string) => `${type}:${id}`

// Front-only mode has no backend; persist per-user recency in localStorage so the
// "recent" lists still reflect this user's own history within the browser.
function lsKey(): string | null {
  const userId = useAppStore.getState().user?.id
  return userId != null ? `linkr:visits:${userId}` : null
}

function readLocal(): Record<string, string> {
  const k = lsKey()
  if (!k) return {}
  try {
    return JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function writeLocal(map: Record<string, string>): void {
  const k = lsKey()
  if (k) localStorage.setItem(k, JSON.stringify(map))
}

export const useVisitStore = create<VisitState>((set, get) => ({
  lastVisited: {},
  loaded: false,

  loadVisits: async () => {
    if (isServerMode()) {
      try {
        const visits = await apiRequest<EntityVisit[]>('/visits')
        const map: Record<string, string> = {}
        for (const v of visits) map[key(v.entityType, v.entityId)] = v.visitedAt
        set({ lastVisited: map, loaded: true })
      } catch {
        set({ loaded: true })
      }
    } else {
      set({ lastVisited: readLocal(), loaded: true })
    }
  },

  recordVisit: (entityType, entityId) => {
    const visitedAt = new Date().toISOString()
    set((s) => ({ lastVisited: { ...s.lastVisited, [key(entityType, entityId)]: visitedAt } }))
    if (isServerMode()) {
      apiRequest('/visits', {
        method: 'POST',
        body: JSON.stringify({ entityType, entityId, visitedAt }),
      }).catch(() => { /* best-effort: recency is non-critical */ })
    } else {
      writeLocal(get().lastVisited)
    }
  },
}))

/** Sort a list newest-visited-first, falling back to `updatedAt` for never-visited items. */
export function sortByRecency<T>(
  items: T[],
  entityType: VisitEntityType,
  getId: (item: T) => string,
  getUpdatedAt: (item: T) => string,
): T[] {
  const { lastVisited } = useVisitStore.getState()
  const stamp = (item: T) => lastVisited[key(entityType, getId(item))] ?? getUpdatedAt(item)
  return [...items].sort((a, b) => new Date(stamp(b)).getTime() - new Date(stamp(a)).getTime())
}
