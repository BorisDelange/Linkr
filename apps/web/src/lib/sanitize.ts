/**
 * Lightweight HTML/SVG sanitizer using the browser's built-in DOMParser.
 * Removes <script> tags and on* event handler attributes.
 * Suitable for content from trusted-but-untrusted sources (runtime outputs).
 */
export function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(dirty, 'text/html')

  // Remove all <script> elements
  for (const el of doc.querySelectorAll('script')) {
    el.remove()
  }

  // Remove on* event handler attributes from all elements
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name)
      }
    }
  }

  return doc.body.innerHTML
}
