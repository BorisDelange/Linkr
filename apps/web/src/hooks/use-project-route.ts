import { useMatch } from 'react-router'

/**
 * The project uid from the URL when we're on a project-scoped route
 * (/workspaces/:wsUid/projects/:uid/…), else null. Use this — not the app-store's
 * `activeProjectUid`, which lingers after leaving a project — to decide whether
 * project-scoped chrome (footer kernels, env manager, jobs) should show.
 */
export function useProjectRouteUid(): string | null {
  const match = useMatch('/workspaces/:wsUid/projects/:uid/*')
  return match?.params.uid ?? null
}
