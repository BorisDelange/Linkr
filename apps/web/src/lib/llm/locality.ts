/**
 * Client-side mirror of the server's endpoint-locality rule
 * (`apps/api/app/services/llm/endpoint_locality.py`), used only to decide whether
 * to show the red "external API" badge.
 *
 * The SERVER is authoritative: it derives and stores `is_local` when a provider is
 * saved, and enforces LINKR_ALLOW_REMOTE_LLM. This copy exists so the badge is
 * right without a round-trip — never as a security decision. Keep the two in
 * sync; both are covered by tests using the same cases.
 */

/** Suffixes reserved for private/internal naming. Mirrors the Python tuple. */
const INTERNAL_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.home.arpa',
]

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function hostOf(url: string): string | null {
  const candidate = (url || '').trim()
  if (!candidate) return null
  try {
    // URL needs a scheme; tolerate "localhost:11434" like the server does.
    const withScheme = candidate.includes('//') ? candidate : `//${candidate}`
    const parsed = new URL(withScheme, 'http://placeholder.invalid')
    if (parsed.hostname === 'placeholder.invalid') return null
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function isPrivateIpv4(host: string): boolean | null {
  const match = IPV4_RE.exec(host)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return null
  const [a, b] = parts
  if (a === 127 || a === 0) return true
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

/** True if `url` points at the local machine or a private network. */
export function isLocalEndpoint(url: string): boolean {
  const host = hostOf(url)
  if (host === null) return false

  const ipv4 = isPrivateIpv4(host)
  if (ipv4 !== null) return ipv4

  if (host === '::1' || host === '::') return true
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  if (host.includes(':')) return false // any other IPv6 literal is public

  if (host === 'localhost') return true
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  return !host.includes('.') && HOSTNAME_RE.test(host)
}
