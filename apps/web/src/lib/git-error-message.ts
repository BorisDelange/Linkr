import type { GitErrorCode } from '@/lib/api/git'
import { GitRemoteError } from '@/lib/api/git'

/** Normalize any thrown value into {code, raw} for the error UI. */
export function toGitError(err: unknown): { code: GitErrorCode; raw: string } {
  if (err instanceof GitRemoteError) return { code: err.code, raw: err.rawMessage }
  return { code: 'unknown', raw: err instanceof Error ? err.message : String(err) }
}
