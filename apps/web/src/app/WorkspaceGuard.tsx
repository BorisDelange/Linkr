import { useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'

/**
 * Route guard that syncs workspace context from the URL `:wsUid` param.
 * Wraps all workspace-level and project-level routes.
 *
 * Only re-opens a workspace when the URL param changes (navigating to a
 * different workspace). Ignores changes to activeWorkspaceId alone — this
 * prevents the guard from re-opening a workspace that was just closed
 * via closeWorkspace() while the old route is still mounted.
 */
export function WorkspaceGuard({ children }: { children: React.ReactNode }) {
  const { wsUid } = useParams()
  const { activeWorkspaceId, _workspacesRaw, workspacesLoaded, openWorkspace } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)
  const prevWsUid = useRef<string | null | undefined>(null)

  useEffect(() => {
    if (!wsUid || !workspacesLoaded) return

    // Only sync when the URL workspace changes, or on first mount
    const wsUidChanged = wsUid !== prevWsUid.current
    prevWsUid.current = wsUid

    if (wsUid === activeWorkspaceId) return
    // If the URL param didn't change, don't re-open (closeWorkspace was called)
    if (!wsUidChanged && activeWorkspaceId === null) return

    const ws = _workspacesRaw.find((w) => w.id === wsUid)
    if (ws) {
      const name = ws.name[language] ?? ws.name['en'] ?? Object.values(ws.name)[0] ?? ''
      openWorkspace(ws.id, name)
    }
  }, [wsUid, activeWorkspaceId, workspacesLoaded, _workspacesRaw, language, openWorkspace])

  // Block rendering until the workspace context is synced
  if (wsUid && wsUid !== activeWorkspaceId) {
    return null
  }

  return <>{children}</>
}
