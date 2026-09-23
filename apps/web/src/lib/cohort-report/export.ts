/**
 * Browser side of the cohort report: turning the rendered report into a file or
 * a print job. Kept apart from the renderers, which are pure and tested.
 */
import type { Rasterize } from './render-docx'

/** Draw an SVG string onto a canvas at 2× and return the PNG bytes. */
export const rasterizeSvg: Rasterize = (svg) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      const width = img.naturalWidth || 640
      const height = img.naturalHeight || 240
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = width * scale
      canvas.height = height * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('no 2d context'))
        return
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('rasterisation failed'))
        resolve({ data: new Uint8Array(await blob.arrayBuffer()), width, height })
      }, 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('the chart could not be drawn'))
    }
    img.src = url
  })

/**
 * Print the report through the browser's own dialog, where "Save as PDF" makes
 * the PDF. The report's stylesheet already lays it out on A4; a hidden frame
 * keeps the app itself out of the printout.
 */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    frame.onload = () => {
      const win = frame.contentWindow
      if (!win) {
        frame.remove()
        resolve()
        return
      }
      // Removed after the dialog closes, not before: Safari prints nothing from
      // a frame that is already gone.
      win.addEventListener('afterprint', () => { frame.remove(); resolve() }, { once: true })
      win.focus()
      win.print()
    }
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}

/** `rapport-cohorte-<slug>-<YYYY-MM-DD>` style base name, without extension. */
export function reportFileName(prefix: string, title: string, date: Date): string {
  const slug = title
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'cohort'
  return `${prefix}-${slug}-${date.toISOString().slice(0, 10)}`
}
