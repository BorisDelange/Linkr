import { useEffect, useState } from 'react'
import { isServerMode } from '@/lib/api-client'
import { gitHostTokenStatus } from '@/lib/api/git'

/**
 * Whether the account holds a token for `host` — its presence only, the token
 * itself never comes back. null while unknown (no host, or in flight). Keyed on
 * the host, not the URL, so typing the rest of a repo path asks nothing new.
 */
export function useHostToken(host: string | null | undefined): boolean | null {
  const [status, setStatus] = useState<{ host: string; hasToken: boolean } | null>(null)
  useEffect(() => {
    if (!host || !isServerMode()) return
    let cancelled = false
    gitHostTokenStatus(`https://${host}/`)
      .then((s) => { if (!cancelled) setStatus({ host, hasToken: s.hasToken }) })
      .catch(() => { /* unknown: the token field then reads as required */ })
    return () => { cancelled = true }
  }, [host])
  return status && status.host === host ? status.hasToken : null
}
