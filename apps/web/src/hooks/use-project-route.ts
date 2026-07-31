import { useMatch } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import { resolveByIdPrefix } from '@/lib/short-id'

/**
 * The FULL project uid from the URL when we're on a project-scoped route
 * (/workspaces/:wsUid/projects/:uid/…), else null. Use this — not the app-store's
 * `activeProjectUid`, which lingers after leaving a project — to decide whether
 * project-scoped chrome (footer kernels, env manager, jobs) should show.
 *
 * The URL param is an 8-char prefix (see short-id.ts); we resolve it to the full
 * uid so callers can hit the API (which keys on the full uid). Uses `useMatch`
 * (not `useParams`) so it works in the footer, outside the route element tree.
 */
export function useProjectRouteUid(): string | null {
  const match = useMatch('/workspaces/:wsUid/projects/:uid/*')
  const projects = useAppStore((s) => s.projects)
  const prefix = match?.params.uid
  if (!prefix) return null
  return resolveByIdPrefix(projects, prefix, (p) => p.uid)?.uid ?? null
}
