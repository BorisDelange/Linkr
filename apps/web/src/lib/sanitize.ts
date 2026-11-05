/**
 * HTML/SVG sanitizer for markup another principal wrote: warehouse note text,
 * plugin and kernel figures, project files brought in by git or a ZIP.
 *
 * An allowlist (DOMPurify's HTML and SVG profiles), never a denylist: whatever is
 * not known to be inert is dropped — frames and their srcdoc, scripts, handlers in
 * any case, javascript: URLs, foreignObject. It runs on the string the caller
 * assigns to innerHTML, i.e. on the HTML parse the browser will make of it.
 */
import DOMPurify from 'dompurify'

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: ['iframe', 'frame', 'frameset', 'object', 'embed', 'foreignObject', 'meta', 'base', 'link', 'form'],
  FORBID_ATTR: ['srcdoc', 'formaction'],
}

// A page-lifetime counter so every rendered SVG gets a distinct id namespace.
let _svgIdSeq = 0

/** Rewrite every internal id in an SVG (and every reference to it) with a
 *  per-figure prefix, so several SVGs on the same page don't collide.
 *
 *  svglite derives `<clipPath>` ids from the device size, so two figures rendered
 *  at the same size share the SAME id. In one DOM, `url(#id)` resolves to the FIRST
 *  matching def, so the second figure gets clipped by the first figure's clip region
 *  → it renders blank. Only ONE R plot per dashboard tab showed; which one depended
 *  on DOM order. Namespacing the ids per figure fixes the collision. */
function namespaceSvgIds(root: Element): void {
  const prefix = `lk${_svgIdSeq++}-`
  const ids = new Set<string>()
  for (const el of root.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')
    if (id) ids.add(id)
  }
  if (ids.size === 0) return

  const rename = (id: string) => `${prefix}${id}`
  // Rewrite the definitions.
  for (const el of root.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')
    if (id && ids.has(id)) el.setAttribute('id', rename(id))
  }
  // Rewrite every reference: url(#id) in any attribute or inline style, and
  // href/xlink:href="#id".
  const urlRef = /url\(\s*#([^\s)"']+)\s*\)/g
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      let v = attr.value
      if (v.includes('url(#')) {
        v = v.replace(urlRef, (m, id) => (ids.has(id) ? `url(#${rename(id)})` : m))
      }
      if ((attr.name === 'href' || attr.name === 'xlink:href') && v.startsWith('#')) {
        const id = v.slice(1)
        if (ids.has(id)) v = `#${rename(id)}`
      }
      if (v !== attr.value) el.setAttribute(attr.name, v)
    }
  }
}

export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(namespaceStandaloneSvg(dirty), PURIFY_CONFIG)
}

/** Namespace the ids of a standalone SVG (an svglite figure), returned
 *  re-serialized; anything else unchanged.
 *
 *  The SVG is read as XML for this step: the HTML parser mishandles the
 *  `<style><![CDATA[…]]></style>` svglite emits, and case-sensitive names
 *  (`clipPath`, `viewBox`) must survive for the figure to render — a broken
 *  clipPath blanks a ggplot using `coord_cartesian(clip = "off")`. This step only
 *  renames ids; sanitizing happens afterwards, on the serialized text. */
function namespaceStandaloneSvg(dirty: string): string {
  const trimmed = dirty.trimStart()
  if (!trimmed.startsWith('<svg') && !trimmed.startsWith('<?xml')) return dirty
  const svgDoc = new DOMParser().parseFromString(dirty, 'image/svg+xml')
  if (svgDoc.querySelector('parsererror') || !svgDoc.documentElement) return dirty
  namespaceSvgIds(svgDoc.documentElement)
  return new XMLSerializer().serializeToString(svgDoc.documentElement)
}
