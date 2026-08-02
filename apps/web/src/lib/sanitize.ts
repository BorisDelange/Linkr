/**
 * Lightweight HTML/SVG sanitizer using the browser's built-in DOMParser.
 * Removes <script> tags and on* event handler attributes.
 * Suitable for content from trusted-but-untrusted sources (runtime outputs).
 */

/** Strip <script> elements and on* handler attributes from a parsed document root. */
function stripDangerous(root: ParentNode): void {
  for (const el of root.querySelectorAll('script')) {
    el.remove()
  }
  for (const el of root.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name)
      }
    }
  }
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
  // Standalone SVG (e.g. an svglite figure) MUST be parsed as XML, not HTML: the
  // HTML parser lowercases tag/attribute names, so `clipPath`, `viewBox`,
  // `clipPathUnits` etc. break — and it mishandles the `<style><![CDATA[…]]></style>`
  // svglite emits. A broken clipPath makes the whole figure render blank (this bit
  // ggplot plots using `coord_cartesian(clip = "off")`, whose panel relies on the
  // clipPath/coordinate system surviving intact). Parse SVG as image/svg+xml to
  // preserve case-sensitive names, namespaces, and CDATA.
  const trimmed = dirty.trimStart()
  const isSvg = trimmed.startsWith('<svg') || trimmed.startsWith('<?xml')
  if (isSvg) {
    const svgDoc = new DOMParser().parseFromString(dirty, 'image/svg+xml')
    // A malformed SVG yields a <parsererror>; fall back to HTML parsing rather than
    // rendering the browser's error markup.
    if (!svgDoc.querySelector('parsererror') && svgDoc.documentElement) {
      stripDangerous(svgDoc)
      // Namespace internal ids so multiple figures on the page don't collide (a
      // shared clipPath id would blank all but the first — see namespaceSvgIds).
      namespaceSvgIds(svgDoc.documentElement)
      return new XMLSerializer().serializeToString(svgDoc.documentElement)
    }
  }

  const doc = new DOMParser().parseFromString(dirty, 'text/html')
  stripDangerous(doc)
  return doc.body.innerHTML
}
