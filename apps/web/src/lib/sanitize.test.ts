// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from './sanitize'

/** The fragment as the browser builds it from the innerHTML assignment. */
function rendered(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

function attributeNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes, (a) => a.name.toLowerCase()))
}

const SVGLITE = `<?xml version='1.0' encoding='UTF-8' ?>
<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='720pt' height='576pt' viewBox='0 0 720 576'>
<g class='svglite'>
<defs>
  <style type='text/css'><![CDATA[
    .svglite line, .svglite polyline { fill: none; stroke: #000000; }
  ]]></style>
</defs>
<rect width='100%' height='100%' style='stroke: none; fill: #FFFFFF;'/>
<defs><clipPath id='cpMC4wMHw3MjAuMDA='><rect x='0.00' y='0.00' width='720.00' height='576.00' /></clipPath></defs>
<g clip-path='url(#cpMC4wMHw3MjAuMDA=)'><polyline points='1,2 3,4' style='stroke-width: 1.07;' /></g>
</g>
</svg>`

describe('sanitizeHtml', () => {
  it('drops a frame whose srcdoc carries a script', () => {
    const out = rendered(
      sanitizeHtml('<p>note</p><iframe srcdoc="<script>parent.document.title=parent.localStorage.length</script>"></iframe>'),
    )
    expect(out.querySelector('iframe')).toBeNull()
    expect(out.innerHTML).not.toContain('srcdoc')
    expect(out.querySelector('p')?.textContent).toBe('note')
  })

  it('drops an event handler written in upper case on an SVG element', () => {
    const out = rendered(
      sanitizeHtml('<svg xmlns="http://www.w3.org/2000/svg"><image href="x" ONERROR="alert(parent.localStorage.length)"/></svg>'),
    )
    expect(attributeNames(out).filter((n) => n.startsWith('on'))).toEqual([])
  })

  it('drops javascript: links in HTML and in SVG', () => {
    const html = rendered(sanitizeHtml('<a href="javascript:alert(1)">x</a>'))
    const svg = rendered(sanitizeHtml('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>'))
    expect(html.innerHTML).not.toContain('javascript:')
    expect(svg.innerHTML).not.toContain('javascript:')
  })

  it('drops scripts, handlers, embedded documents and foreignObject', () => {
    const out = rendered(
      sanitizeHtml(
        '<img src="x" onerror="alert(1)"><script>alert(1)</script><object data="x"></object><embed src="x">' +
          '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="x"></iframe></foreignObject></svg>',
      ),
    )
    expect(out.querySelectorAll('script, object, embed, iframe, foreignObject')).toHaveLength(0)
    expect(attributeNames(out).filter((n) => n.startsWith('on'))).toEqual([])
  })

  it('keeps the formatting of a note', () => {
    const out = rendered(sanitizeHtml('<p>Admission <b>J0</b><br>suite</p><table><tr><td>Na</td><td>140</td></tr></table>'))
    expect(out.querySelector('b')?.textContent).toBe('J0')
    expect(out.querySelectorAll('td')).toHaveLength(2)
  })

  it('keeps an svglite figure renderable, ids namespaced', () => {
    const out = rendered(sanitizeHtml(SVGLITE))
    const svg = out.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 720 576')
    const clip = svg.querySelector('clipPath')!
    expect(clip.id).toMatch(/^lk\d+-cpMC4wMHw3MjAuMDA=$/)
    expect(svg.querySelector('g[clip-path]')!.getAttribute('clip-path')).toBe(`url(#${clip.id})`)
    expect(svg.querySelector('style')!.textContent).toContain('.svglite line')
    expect(svg.querySelector('polyline')!.getAttribute('style')).toContain('stroke-width')
  })
})
