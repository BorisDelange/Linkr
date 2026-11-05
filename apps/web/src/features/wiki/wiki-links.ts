import type { WikiPage } from '@/types'

const WIKILINK_PREFIX = '#wiki-page-'

export function wikilinkHref(pageId: string): string {
  return `${WIKILINK_PREFIX}${pageId}`
}

/**
 * The wiki page a link in page content points to, or null when it points
 * elsewhere (an external URL, an in-page heading, an app route).
 *
 * Relative links name the target the way the exported tree does — `wiki/` holds
 * one `<entityId>.md` per page (`<slug>--<id>.md` for pages without one, plus
 * `<name>.<lang>.md` per extra language) — so `[Setup](setup-guide.md)` follows
 * in Linkr and on the git host alike. The bare name and the page slug also work.
 */
export function resolveWikiHref(href: string | undefined, pages: WikiPage[]): string | null {
  if (!href) return null
  if (href.startsWith(WIKILINK_PREFIX)) {
    const id = href.slice(WIKILINK_PREFIX.length)
    return pages.some((p) => p.id === id) ? id : null
  }
  if (href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null

  const path = href.split(/[?#]/)[0]
  let name: string
  try {
    name = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '')
  } catch {
    return null
  }
  if (name.endsWith('.md')) name = name.slice(0, -3).replace(/\.[a-z]{2}$/, '')
  if (!name) return null

  const target = pages.find((p) => p.entityId === name)
    ?? pages.find((p) => name.endsWith(`--${p.id}`))
    ?? pages.find((p) => p.slug === name)
  return target?.id ?? null
}
