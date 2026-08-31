/**
 * URL params resolved from short id prefixes (see short-id.ts) back to full ids.
 *
 * Route params (:wsUid, :uid) carry an 8-char prefix in the URL, but the rest of the app works
 * with full ids (store keys, equality checks, child props). This hook does the prefix→full
 * resolution once per page, so consumers read full ids and never have to know about shortening.
 *
 * A full id resolves to itself (it's a prefix of itself), so pre-shortening links keep working.
 * If a prefix is unknown/ambiguous, the resolved id is undefined — the guards already block
 * rendering in that case, so pages can treat it like a missing param.
 */
import { useLocation, useParams } from 'react-router'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useAppStore } from '@/stores/app-store'
import { resolveByIdPrefix } from '@/lib/short-id'

export interface ResolvedParams {
  /** Full workspace id (from the :wsUid prefix), or undefined. */
  wsUid?: string
  /** Full project uid (from the :uid prefix), or undefined. */
  projectUid?: string
  /** The raw route params, for any id this hook doesn't resolve (detail pages resolve those locally). */
  raw: Record<string, string | undefined>
}

/**
 * The `:wsUid` / `:uid` prefixes read straight off the pathname.
 *
 * `useParams()` only sees a match from an enclosing `<Route>`, and returns `{}`
 * for anything rendered as a sibling of `<Routes>` — which the Header is, along
 * with every entity dialog it mounts from its badge menus. Those consumers
 * previously read an undefined `wsUid` on EVERY render, not just a cold one, so
 * a workspace-scoped fetch behind a `!wsUid` guard never fired at all (the schema
 * dropdown in the database edit dialog silently offered nothing).
 */
export function paramsFromPath(pathname: string): Record<string, string | undefined> {
  const wsUid = pathname.match(/^\/workspaces\/([^/]+)/)?.[1]
  const uid = pathname.match(/^\/workspaces\/[^/]+\/projects\/([^/]+)/)?.[1]
  return { wsUid, uid }
}

export function useResolvedParams(): ResolvedParams {
  const routeParams = useParams() as Record<string, string | undefined>
  const { pathname } = useLocation()
  const workspaces = useWorkspaceStore((s) => s._workspacesRaw)
  const projects = useAppStore((s) => s.projects)

  // Route params win — they are the match the router actually made. The pathname
  // only fills in what a caller outside `<Routes>` cannot get any other way.
  const fromPath = paramsFromPath(pathname)
  const raw = { ...routeParams }
  if (raw.wsUid === undefined) raw.wsUid = fromPath.wsUid
  if (raw.uid === undefined) raw.uid = fromPath.uid

  const wsUid = resolveByIdPrefix(workspaces, raw.wsUid, (w) => w.id)?.id
  const projectUid = resolveByIdPrefix(projects, raw.uid, (p) => p.uid)?.uid

  return { wsUid, projectUid, raw }
}
