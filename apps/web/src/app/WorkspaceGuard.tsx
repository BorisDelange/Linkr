import { useEffect } from 'react'
import { useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'

/**
 * Route guard that syncs workspace context from the URL `:wsUid` param.
 * Wraps all workspace-level and project-level routes.
 */
export function WorkspaceGuard({ children }: { children: React.ReactNode }) {
  const { wsUid } = useParams()
  const { activeWorkspaceId, _workspacesRaw, workspacesLoaded, openWorkspace } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)

  useEffect(() => {
    if (!wsUid || !workspacesLoaded) return
    if (wsUid === activeWorkspaceId) return

    const ws = _workspacesRaw.find((w) => w.id === wsUid)
    if (ws) {
      const name = ws.name[language] ?? ws.name['en'] ?? Object.values(ws.name)[0] ?? ''
      openWorkspace(ws.id, name)
    }
  }, [wsUid, activeWorkspaceId, workspacesLoaded, _workspacesRaw, language, openWorkspace])

  return <>{children}</>
}
