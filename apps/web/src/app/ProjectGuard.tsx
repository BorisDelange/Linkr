import { useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'

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
  const { uid } = useParams()
  const { activeProjectUid, projects, projectsLoaded, openProject } = useAppStore()
  const prevUid = useRef<string | null | undefined>(null)

  useEffect(() => {
    if (!uid || !projectsLoaded) return

    // Only sync when the URL project changes, or on first mount
    const uidChanged = uid !== prevUid.current
    prevUid.current = uid

    if (uid === activeProjectUid) return
    // If the URL param didn't change, don't re-open (closeProject was called)
    if (!uidChanged && activeProjectUid === null) return

    const project = projects.find((p) => p.uid === uid)
    if (project) {
      openProject(project.uid, project.name)
    }
  }, [uid, activeProjectUid, projectsLoaded, projects, openProject])

  // Block rendering until the project context is synced to avoid
  // a flash of the workspace sidebar on direct URL load.
  if (uid && uid !== activeProjectUid) {
    return null
  }

  return <>{children}</>
}
