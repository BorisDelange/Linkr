import { useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { resolveByIdPrefix } from '@/lib/short-id'
import { paths } from '@/lib/paths'
import { EntityNotFound } from '@/components/layout/EntityNotFound'

/**
 * Route guard that syncs project context from the URL `:uid` param.
 * Wraps all project-level routes.
 *
 * Only re-opens a project when the URL param changes (navigating to a
 * different project). Ignores changes to activeProjectUid alone — this
 * prevents the guard from re-opening a project that was just closed
 * via closeProject() while the old route is still mounted.
 */
export function ProjectGuard({ children }: { children: React.ReactNode }) {
  const { wsUid, uid } = useParams()
  const { t } = useTranslation()
  const { activeProjectUid, projects, projectsLoaded, openProject } = useAppStore()
  const prevUid = useRef<string | null | undefined>(null)

  // The URL carries a short id prefix; resolve it to the full project uid before comparing
  // against activeProjectUid (always the full uid).
  const resolvedProject = resolveByIdPrefix(projects, uid, (p) => p.uid)
  const resolvedUid = resolvedProject?.uid

  useEffect(() => {
    if (!uid || !projectsLoaded) return

    // Only sync when the URL project changes, or on first mount
    const uidChanged = uid !== prevUid.current
    prevUid.current = uid

    if (resolvedUid && resolvedUid === activeProjectUid) return
    // If the URL param didn't change, don't re-open (closeProject was called)
    if (!uidChanged && activeProjectUid === null) return

    if (resolvedProject) {
      openProject(resolvedProject.uid, resolvedProject.name)
    }
  }, [uid, resolvedProject, resolvedUid, activeProjectUid, projectsLoaded, openProject])

  // Projects loaded but the URL points at a project that doesn't exist (deleted, or a bad/stale
  // id) — show a clear "not found" state with a way back to the workspace's projects list.
  if (uid && projectsLoaded && !resolvedProject) {
    return (
      <EntityNotFound
        entityLabel={t('common.entity_project')}
        entityId={uid}
        backTo={paths.projects(wsUid ?? '')}
        backLabel={t('common.back_to_projects')}
      />
    )
  }

  // Block rendering until the project context is synced to avoid
  // a flash of the workspace sidebar on direct URL load.
  if (uid && projectsLoaded && resolvedUid !== activeProjectUid) {
    return null
  }

  return <>{children}</>
}
