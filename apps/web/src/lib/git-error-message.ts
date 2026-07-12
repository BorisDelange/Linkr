import type { GitErrorCode } from '@/lib/api/git'
import { GitRemoteError } from '@/lib/api/git'

/** i18n key for the friendly one-line message of a git error code. */
export function gitErrorMessageKey(code: GitErrorCode): string {
  switch (code) {
    case 'auth_required':
      return 'versioning.git_err_auth_required'
    case 'auth_failed':
      return 'versioning.git_err_auth_failed'
    case 'not_found':
      return 'versioning.git_err_not_found'
    case 'network':
      return 'versioning.git_err_network'
    default:
      return 'versioning.git_err_unknown'
  }
}

/** Normalize any thrown value into {code, raw} for the error UI. */
export function toGitError(err: unknown): { code: GitErrorCode; raw: string } {
  if (err instanceof GitRemoteError) return { code: err.code, raw: err.rawMessage }
  return { code: 'unknown', raw: err instanceof Error ? err.message : String(err) }
}
