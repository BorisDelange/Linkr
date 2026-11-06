// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
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

// jsdom builds style sheets only for a document with a window, which a browser's
// inert document does not need.
beforeAll(() => {
  vi.spyOn(document.implementation, 'createHTMLDocument').mockImplementation(() => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    return frame.contentDocument!
  })
})

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

  describe('stored markup keeps to its own box', () => {
    const FIG = (css: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>${css}</style><rect width="1" height="1"/></svg>`

    function inDocument(html: string) {
      const host = rendered(html)
      const outside = document.createElement('button')
      document.body.append(host, outside)
      const sheet = document.createElement('style')
      sheet.textContent = host.querySelector('style')?.textContent ?? ''
      document.head.append(sheet)
      const rules = Array.from(sheet.sheet?.cssRules ?? []) as CSSStyleRule[]
      return { host, outside, rules }
    }

    it('applies the rules of a figure inside that figure only', () => {
      const { host, outside, rules } = inDocument(sanitizeHtml(FIG('*, rect, button { fill: red } svg { stroke: blue }')))
      expect(rules.length).toBeGreaterThan(0)
      for (const rule of rules) expect(outside.matches(rule.selectorText)).toBe(false)
      expect(host.querySelector('rect')!.matches(rules[0].selectorText)).toBe(true)
      expect(host.querySelector('svg')!.matches(rules[1].selectorText)).toBe(true)
    })

    it('keeps a closing brace in a figure style from ending its scope', () => {
      const { outside, rules } = inDocument(sanitizeHtml(FIG('rect { fill: red } } button { display: none } .x { fill: blue }')))
      for (const rule of rules) expect(outside.matches(rule.selectorText)).toBe(false)
    })

    it('drops at-rules and declarations that lay a figure over the page', () => {
      const style = rendered(sanitizeHtml(FIG('@import url(x.css); @font-face { font-family: f; src: url(x) } svg { position: fixed; inset: 0; z-index: 99; fill: red; background: url(https://x.test/a) }'))).querySelector('style')!
      expect(style.textContent).toContain('fill')
      expect(style.textContent).not.toMatch(/@import|@font-face|position|inset|z-index|https:/)
    })

    it('drops a style element outside a figure', () => {
      const out = rendered(sanitizeHtml('<p>note</p><style>button { display: none }</style><svg><title><style>a{}</style></title></svg>'))
      expect(out.querySelector('style')).toBeNull()
      expect(out.querySelector('p')?.textContent).toBe('note')
    })

    it('keeps formatting declarations and drops positioning on markup and on a figure root', () => {
      const out = rendered(sanitizeHtml(
        '<div style="position:fixed;inset:0;z-index:50;color:red;text-align:center;margin-top:-500px;transform:scale(9)">x</div>' +
          '<svg style="position:fixed;top:0;fill:red" transform="translate(1,1)"><rect/></svg>',
      ))
      const div = out.querySelector('div')!.getAttribute('style')!
      expect(div).toContain('color:red')
      expect(div).toContain('text-align:center')
      expect(div).not.toMatch(/position|inset|z-index|margin|transform/)
      const svg = out.querySelector('svg')!
      expect(svg.getAttribute('style')).toBe('fill:red')
      expect(svg.hasAttribute('transform')).toBe(false)
    })

    it("does not let markup borrow the app's classes", () => {
      const out = rendered(sanitizeHtml('<div class="fixed inset-0 z-50">x</div><svg class="svglite fixed"><rect class="own"/></svg>'))
      expect(out.querySelector('div')!.hasAttribute('class')).toBe(false)
      expect(out.querySelector('svg')!.getAttribute('class')).toBe('svglite')
      expect(out.querySelector('rect')!.getAttribute('class')).toBe('own')
    })

    it('does not trust a scope marker found in the markup', () => {
      const out = rendered(sanitizeHtml('<p data-lk-scope="lk1">x</p>'))
      expect(out.querySelector('p')!.hasAttribute('data-lk-scope')).toBe(false)
    })

    it('keeps the highlight a note search adds', () => {
      const out = rendered(sanitizeHtml('<p>a <mark style="background:rgb(254 240 138);border-radius:2px;padding:0 2px;">b</mark></p>'))
      expect(out.querySelector('mark')!.getAttribute('style')).toContain('background:rgb(254 240 138)')
      expect(out.querySelector('mark')!.getAttribute('style')).toContain('padding:0 2px')
    })

    it('keeps a matplotlib figure global reset working inside it', () => {
      const { host, rules } = inDocument(sanitizeHtml(FIG('*{stroke-linejoin: round; stroke-linecap: butt}')))
      expect(rules[0].style.getPropertyValue('stroke-linejoin')).toBe('round')
      expect(host.querySelector('rect')!.matches(rules[0].selectorText)).toBe(true)
    })
  })
})
