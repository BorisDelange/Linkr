import { describe, it, expect } from 'vitest'
import { withResponsiveSvg } from './svg-responsive'

describe('withResponsiveSvg', () => {
  it('drops hard width/height so CSS can size the SVG', () => {
    const out = withResponsiveSvg('<svg width="400" height="300" viewBox="0 0 400 300"><rect/></svg>')
    expect(out).not.toMatch(/width="400"/)
    expect(out).not.toMatch(/height="300"/)
    expect(out).toMatch(/viewBox="0 0 400 300"/)
  })

  it('synthesises a viewBox from width/height when missing', () => {
    const out = withResponsiveSvg('<svg width="640" height="480"><rect/></svg>')
    expect(out).toMatch(/viewBox="0 0 640 480"/)
  })

  it('keeps an existing viewBox untouched', () => {
    const out = withResponsiveSvg('<svg viewBox="0 0 10 20"><rect/></svg>')
    expect(out).toMatch(/viewBox="0 0 10 20"/)
  })

  it('returns input unchanged when there is no <svg> tag', () => {
    expect(withResponsiveSvg('not an svg')).toBe('not an svg')
  })

  it('preserves the inner content', () => {
    const out = withResponsiveSvg('<svg width="100" height="100"><circle cx="5"/></svg>')
    expect(out).toContain('<circle cx="5"/>')
  })
})
