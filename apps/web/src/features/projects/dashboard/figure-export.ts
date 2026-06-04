import { toPng, toSvg } from 'html-to-image'
import JSZip from 'jszip'
import { downloadBlob } from '@/lib/entity-io'

export type ExportFormat = 'png' | 'svg'

/** Default raster density for PNG exports, in DPI (96 = 1× CSS pixels). */
export const DEFAULT_DPI = 192

/** Convert a DPI value to an html-to-image pixelRatio (relative to the 96-DPI CSS baseline). */
function dpiToPixelRatio(dpi: number): number {
  return Math.max(0.5, dpi / 96)
}

/** A widget's DOM node + a filename-safe label, for batch export. */
export interface ExportTarget {
  id: string
  name: string
  node: HTMLElement
}

/** Make a string safe to use as a file name. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return cleaned || 'widget'
}

/**
 * Find a widget's exportable DOM node by its id. Prefers the inner content
 * (the chart itself, without the title bar / edit chrome) when available.
 */
export function findWidgetNode(widgetId: string): HTMLElement | null {
  const wrapper = document.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(widgetId)}"]`)
  if (!wrapper) return null
  return wrapper.querySelector<HTMLElement>('[data-widget-content]') ?? wrapper
}

/**
 * If the node's chart is a single inline SVG (recharts), serialize it directly —
 * this yields a crisp, editable vector. Returns null when there isn't exactly one
 * top-level chart svg (e.g. Leaflet maps, HTML tables), so callers fall back to raster.
 */
function serializeInlineSvg(node: HTMLElement): string | null {
  const svgs = node.querySelectorAll('svg')
  // Recharts renders one main <svg class="recharts-surface">; ignore tiny icon svgs.
  const chartSvg = Array.from(svgs).find(s => s.classList.contains('recharts-surface'))
  if (!chartSvg || svgs.length === 0) return null
  // Leaflet uses an <svg> overlay too — bail if a leaflet container is present.
  if (node.querySelector('.leaflet-container')) return null

  const clone = chartSvg.cloneNode(true) as SVGSVGElement
  const rect = chartSvg.getBoundingClientRect()
  if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(rect.width)))
  if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(rect.height)))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
}

/** Render a widget node to a Blob in the requested format. `dpi` only affects PNG raster density. */
export async function nodeToBlob(node: HTMLElement, format: ExportFormat, dpi = DEFAULT_DPI): Promise<Blob> {
  const bg = getComputedStyle(node).backgroundColor || '#ffffff'

  if (format === 'svg') {
    const inline = serializeInlineSvg(node)
    if (inline) return new Blob([inline], { type: 'image/svg+xml' })
    // Fallback: rasterize the whole node into an SVG <foreignObject> via html-to-image.
    const dataUrl = await toSvg(node, { backgroundColor: bg, cacheBust: true })
    const svgText = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
    return new Blob([svgText], { type: 'image/svg+xml' })
  }

  const dataUrl = await toPng(node, { backgroundColor: bg, pixelRatio: dpiToPixelRatio(dpi), cacheBust: true })
  const res = await fetch(dataUrl)
  return res.blob()
}

/** Export a single widget node as PNG or SVG (direct download). */
export async function exportWidget(node: HTMLElement, name: string, format: ExportFormat, dpi = DEFAULT_DPI): Promise<void> {
  const blob = await nodeToBlob(node, format, dpi)
  downloadBlob(blob, `${sanitizeFilename(name)}.${format}`)
}

/**
 * Export multiple widgets into a single ZIP. Filenames are de-duplicated against ALL
 * names already used (including auto-suffixed ones), so two widgets can never overwrite
 * each other in the archive. Widgets that fail to render are skipped and returned in `failed`.
 */
export async function exportWidgetsAsZip(
  targets: ExportTarget[],
  format: ExportFormat,
  zipName: string,
  dpi = DEFAULT_DPI,
): Promise<{ exported: number; failed: string[] }> {
  const zip = new JSZip()
  const used = new Set<string>()
  const failed: string[] = []
  let exported = 0

  for (const target of targets) {
    try {
      const blob = await nodeToBlob(target.node, format, dpi)
      const base = sanitizeFilename(target.name)
      let name = base
      let n = 2
      while (used.has(name)) name = `${base}_${n++}`
      used.add(name)
      zip.file(`${name}.${format}`, blob)
      exported++
    } catch {
      failed.push(target.name)
    }
  }

  if (exported > 0) {
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, `${sanitizeFilename(zipName)}.zip`)
  }
  return { exported, failed }
}
