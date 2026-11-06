/**
 * HTML/SVG sanitizer for markup another principal wrote: warehouse note text,
 * plugin and kernel figures, project files brought in by git or a ZIP.
 *
 * An allowlist (DOMPurify's HTML and SVG profiles), never a denylist: whatever is
 * not known to be inert is dropped — frames and their srcdoc, scripts, handlers in
 * any case, javascript: URLs, foreignObject. It runs on the string the caller
 * assigns to innerHTML, i.e. on the HTML parse the browser will make of it.
 *
 * The result lands in the app's document, so markup also keeps to its own box: a
 * figure's `<style>` is rewritten to reach that figure only, a `<style>` anywhere
 * else is dropped, and markup outside an SVG drawing neither positions itself over
 * the page nor borrows the app's classes.
 */
import DOMPurify from 'dompurify'

const SVG_NS = 'http://www.w3.org/2000/svg'

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: ['iframe', 'frame', 'frameset', 'object', 'embed', 'foreignObject', 'meta', 'base', 'link', 'form'],
  FORBID_ATTR: ['srcdoc', 'formaction'],
}

/** Formatting a box can take without leaving it: nothing that positions, floats or moves. */
const SAFE_STYLE_PROPERTY = new RegExp(
  '^(?:' + [
    'color', 'opacity', 'visibility', 'display', 'cursor', 'pointer-events', 'filter', 'mask', 'mix-blend-mode',
    'background(?:-color)?', 'border(?:-[a-z-]+)?', 'padding(?:-[a-z]+)?', 'margin(?:-[a-z]+)?',
    '(?:min-|max-)?(?:width|height)', 'line-height', 'vertical-align', 'white-space', 'direction', 'unicode-bidi',
    'font(?:-[a-z-]+)?', 'text-[a-z-]+', 'letter-spacing', 'word-spacing', 'word-break', 'word-wrap', 'overflow-wrap',
    'list-style(?:-[a-z]+)?', 'table-layout', 'caption-side', 'empty-cells',
    'fill(?:-[a-z]+)?', 'stroke(?:-[a-z]+)?', 'stop-[a-z]+', 'flood-[a-z]+', 'lighting-color', 'marker(?:-[a-z]+)?',
    'clip-path', 'clip-rule', 'paint-order', 'shape-rendering', 'vector-effect',
    'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'writing-mode',
  ].join('|') + ')$',
)

/** Keep the declarations of `SAFE_STYLE_PROPERTY`. Splitting on every `;`, strings
 *  included, can only cut more than a CSS parser would: what it drops stays dropped. */
function safeDeclarations(css: string): string {
  return css
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const colon = declaration.indexOf(':')
      if (colon < 0) return false
      const name = declaration.slice(0, colon).trim().toLowerCase()
      const value = declaration.slice(colon + 1)
      if (!SAFE_STYLE_PROPERTY.test(name) || /[\\@]/.test(value) || /url\(\s*(?!['"]?#)/i.test(value)) return false
      return !(name.startsWith('margin') && value.includes('-'))
    })
    .join(';')
}

const SCOPE_ATTRIBUTE = 'data-lk-scope'
const FIGURE_ROOT_CLASS = /^svglite$/
let _scopeSeq = 0

/**
 * The style rules of `css`, each reaching only `scope` and what it contains, with
 * safe declarations. Read through a parser, so a stray `}` cannot end the scope;
 * at-rules are not kept, so nothing is fetched and no font or keyframes go global.
 */
function scopedCss(css: string, scope: string): string {
  const inert = document.implementation.createHTMLDocument('')
  const style = inert.createElement('style')
  style.textContent = css
  inert.head.append(style)
  const rules: string[] = []
  for (const rule of Array.from(style.sheet?.cssRules ?? [])) {
    if (!('selectorText' in rule)) continue
    const { selectorText, style: declarations } = rule as CSSStyleRule
    const body = safeDeclarations(declarations.cssText)
    if (!body || /[<{}]/.test(selectorText + body)) continue
    rules.push(`${scope}:is(${selectorText}),${scope} :is(${selectorText}){${body}}`)
  }
  return rules.join('\n')
}

const isInSvg = (el: Element) => !!el.parentElement?.closest('svg')

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element
  // Before anything inside it can mark it: an element is walked before its children.
  el.removeAttribute(SCOPE_ATTRIBUTE)
  if (el.localName === 'style') {
    const figure = el.namespaceURI === SVG_NS ? el.parentElement?.closest('svg') : null
    if (!figure) {
      el.remove()
      return
    }
    const id = figure.getAttribute(SCOPE_ATTRIBUTE) ?? `lk${_scopeSeq++}`
    figure.setAttribute(SCOPE_ATTRIBUTE, id)
    el.textContent = scopedCss(el.textContent ?? '', `[${SCOPE_ATTRIBUTE}="${id}"]`)
    return
  }
  if (isInSvg(el)) return
  el.removeAttribute('transform')
  const style = el.getAttribute('style')
  if (style !== null) {
    const safe = safeDeclarations(style)
    if (safe) el.setAttribute('style', safe)
    else el.removeAttribute('style')
  }
  const classes = el.getAttribute('class')
  if (classes !== null) {
    const kept = el.namespaceURI === SVG_NS ? classes.split(/\s+/).filter((c) => FIGURE_ROOT_CLASS.test(c)).join(' ') : ''
    if (kept) el.setAttribute('class', kept)
    else el.removeAttribute('class')
  }
})

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
