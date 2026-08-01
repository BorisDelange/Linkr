/** Make an SVG scale to its container: drop hard width/height so CSS governs size,
 *  keeping the viewBox for the aspect ratio. If there's no viewBox, synthesise one
 *  from the width/height so it stays sharp. Returns the input unchanged when it has
 *  no <svg> tag. */
export function withResponsiveSvg(svg: string): string {
  const openTag = svg.match(/<svg[^>]*>/i)?.[0]
  if (!openTag) return svg
  let tag = openTag
  if (!/viewBox=/i.test(tag)) {
    const w = tag.match(/\bwidth=["']?([\d.]+)/i)?.[1]
    const h = tag.match(/\bheight=["']?([\d.]+)/i)?.[1]
    if (w && h) tag = tag.replace(/<svg/i, `<svg viewBox="0 0 ${w} ${h}"`)
  }
  tag = tag
    .replace(/\swidth=["'][^"']*["']/i, '')
    .replace(/\sheight=["'][^"']*["']/i, '')
  return svg.replace(openTag, tag)
}
