import { useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { resolveByIdPrefix } from '@/lib/short-id'
import { EntityNotFound } from '@/components/layout/EntityNotFound'

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
  const { t } = useTranslation()
  const { activeWorkspaceId, _workspacesRaw, workspacesLoaded, openWorkspace } = useWorkspaceStore()
  const language = useAppStore((s) => s.language)
  const prevWsUid = useRef<string | null | undefined>(null)

  // The URL carries a short id prefix; resolve it to the full workspace id before comparing
  // against activeWorkspaceId (which is always the full id).
  const resolvedWs = resolveByIdPrefix(_workspacesRaw, wsUid, (w) => w.id)
  const resolvedWsId = resolvedWs?.id

  useEffect(() => {
    if (!wsUid || !workspacesLoaded) return

    // Only sync when the URL workspace changes, or on first mount
    const wsUidChanged = wsUid !== prevWsUid.current
    prevWsUid.current = wsUid

    if (resolvedWsId && resolvedWsId === activeWorkspaceId) return
    // If the URL param didn't change, don't re-open (closeWorkspace was called)
    if (!wsUidChanged && activeWorkspaceId === null) return

    if (resolvedWs) {
      const name = resolvedWs.name[language] ?? resolvedWs.name['en'] ?? Object.values(resolvedWs.name)[0] ?? ''
      openWorkspace(resolvedWs.id, name)
    }
  }, [wsUid, resolvedWs, resolvedWsId, activeWorkspaceId, workspacesLoaded, language, openWorkspace])

  // Workspaces loaded but the URL points at a workspace that doesn't exist (deleted, or a
  // bad/stale id) — show a clear "not found" state with a way back to the workspaces list.
  if (wsUid && workspacesLoaded && !resolvedWs) {
    return (
      <EntityNotFound
        entityLabel={t('common.entity_workspace')}
        entityId={wsUid}
        backTo="/workspaces"
        backLabel={t('common.back_to_workspaces')}
      />
    )
  }

  // Block rendering until the workspace context is synced. Once workspaces are loaded and the
  // prefix doesn't resolve to the active workspace, hold (the effect will open it).
  if (wsUid && workspacesLoaded && resolvedWsId !== activeWorkspaceId) {
    return null
  }

  return <>{children}</>
}
