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
import { useParams } from 'react-router'
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

export function useResolvedParams(): ResolvedParams {
  const raw = useParams() as Record<string, string | undefined>
  const workspaces = useWorkspaceStore((s) => s._workspacesRaw)
  const projects = useAppStore((s) => s.projects)

  const wsUid = resolveByIdPrefix(workspaces, raw.wsUid, (w) => w.id)?.id
  const projectUid = resolveByIdPrefix(projects, raw.uid, (p) => p.uid)?.uid

  return { wsUid, projectUid, raw }
}
