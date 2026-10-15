import { useEffect, useCallback, useRef } from 'react'
import { ZoomIn, ZoomOut, Maximize2, Minimize2, Expand } from 'lucide-react'
// vis-network is ~1.4 MB; import it dynamically so it ships in its own chunk and
// loads only when the hierarchy graph actually renders (not with the whole page).
import type { Network, DataSet, Edge } from 'vis-network/standalone'
import { copyText } from '@/lib/clipboard'
import { bindPinchZoom, clampScale } from '@/lib/pinch-zoom'


export type HierarchyConcept = {
  concept_id: number
  concept_name: string
  vocabulary_id: string
  domain_id?: string
  concept_class_id?: string
  concept_code?: string
  standard_concept: string | null
  invalid_reason?: string | null
  hierarchy_level: number
}

interface HierarchyGraphProps {
  self: HierarchyConcept
  ancestors: HierarchyConcept[]
  descendants: HierarchyConcept[]
  edgeRows: { from_id: number; to_id: number }[]
  originId: number | null
  onNavigate: (id: number, name: string) => void
  fullscreen: boolean
  onFullscreenChange: (v: boolean) => void
}

export const HIERARCHY_WARN_THRESHOLD = 100
const GRAPH_MIN_SCALE = 0.05
const GRAPH_MAX_SCALE = 4

function esc(s: string | number) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function HierarchyGraph({ self, ancestors, descendants, edgeRows, originId, onNavigate, fullscreen, onFullscreenChange }: HierarchyGraphProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const networkRef = useRef<Network | null>(null)
  const nodesDataRef = useRef<DataSet<{ id: number; color: unknown; borderWidth: number; font?: unknown }> | null>(null)
  const nodeColorsRef = useRef<Map<number, { bg: string; border: string; border2: number }>>(new Map())
  const pinnedIdRef = useRef<number | null>(null)
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conceptMapRef = useRef<Map<number, HierarchyConcept>>(new Map())

  const hideTooltip = useCallback(() => {
    document.querySelectorAll('.hierarchy-tooltip').forEach((el) => el.remove())
  }, [])

  const applyHoverStyle = useCallback((nodeId: number) => {
    const ds = nodesDataRef.current
    if (!ds) return
    ds.update({ id: nodeId, color: { background: '#ffffff', border: '#9ca3af', highlight: { background: '#ffffff', border: '#9ca3af' } }, font: { color: '#111827', size: 11 }, borderWidth: 2 })
  }, [])

  const applyPinStyle = useCallback((nodeId: number) => {
    const ds = nodesDataRef.current
    if (!ds) return
    ds.update({ id: nodeId, color: { background: '#ffffff', border: '#2563eb', highlight: { background: '#ffffff', border: '#2563eb' } }, font: { color: '#111827', size: 11 }, borderWidth: 3 })
  }, [])

  const restoreStyle = useCallback((nodeId: number) => {
    const ds = nodesDataRef.current
    if (!ds) return
    const orig = nodeColorsRef.current.get(nodeId)
    if (orig) ds.update({ id: nodeId, color: { background: orig.bg, border: orig.border, highlight: { background: orig.bg, border: orig.border } }, font: { color: '#ffffff', size: 11 }, borderWidth: orig.border2 })
  }, [])

  const setPinHighlight = useCallback((nodeId: number | null) => {
    if (pinnedIdRef.current !== null && pinnedIdRef.current !== nodeId) {
      restoreStyle(pinnedIdRef.current)
    }
    if (nodeId !== null) {
      applyPinStyle(nodeId)
    }
  }, [applyPinStyle, restoreStyle])

  const buildTooltip = useCallback((conceptId: number, domPos: { x: number; y: number }, pinned: boolean) => {
    const c = conceptMapRef.current.get(conceptId)
    if (!c) return
    hideTooltip()

    const copyBtn = (v: string) => pinned
      ? `<td style="padding-left:4px;vertical-align:top"><button class="ht-copy" data-copy="${esc(v)}" style="cursor:pointer;background:none;border:none;padding:1px;opacity:0.5;line-height:1" title="Copy"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button></td>`
      : '<td></td>'

    const row = (label: string, value: string, mono = false, withCopy = false) =>
      `<tr>
        <td style="color:var(--muted-foreground);padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;font-size:11px">${label}</td>
        <td style="font-size:11px${mono ? ';font-family:monospace' : ''}">${esc(value)}</td>
        ${withCopy ? copyBtn(value) : '<td></td>'}
      </tr>`

    const stdBadge = c.standard_concept === 'S'
      ? `<span style="display:inline-flex;align-items:center;border-radius:3px;padding:1px 4px;font-size:9px;line-height:1.4;font-weight:500;background:#16a34a;color:#fff;border:1px solid transparent">Standard</span>`
      : c.standard_concept === 'C'
      ? `<span style="display:inline-flex;align-items:center;border-radius:3px;padding:1px 4px;font-size:9px;line-height:1.4;font-weight:500;background:var(--secondary);color:var(--secondary-foreground);border:1px solid transparent">Classification</span>`
      : `<span style="display:inline-flex;align-items:center;border-radius:3px;padding:1px 4px;font-size:9px;line-height:1.4;font-weight:500;background:transparent;color:#ef4444;border:1px solid #fca5a5">Non-standard</span>`

    const isValid = !c.invalid_reason
    const validBadge = isValid
      ? `<span style="display:inline-flex;align-items:center;border-radius:3px;padding:1px 4px;font-size:9px;line-height:1.4;font-weight:500;background:#16a34a;color:#fff;border:1px solid transparent">Valid</span>`
      : `<span style="display:inline-flex;align-items:center;border-radius:3px;padding:1px 4px;font-size:9px;line-height:1.4;font-weight:500;background:transparent;color:#ef4444;border:1px solid #fca5a5">${esc(c.invalid_reason ?? 'Invalid')}</span>`

    const badgeRow = (label: string, badge: string) =>
      `<tr>
        <td style="color:var(--muted-foreground);padding:1px 8px 1px 0;white-space:nowrap;vertical-align:middle;font-size:11px">${label}</td>
        <td style="font-size:11px;padding:1px 0">${badge}</td>
        <td></td>
      </tr>`

    const tip = document.createElement('div')
    tip.className = 'hierarchy-tooltip'
    tip.style.cssText = `position:fixed;z-index:9999;background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,0.18);max-width:320px;pointer-events:${pinned ? 'auto' : 'none'}`
    if (pinned) tip.addEventListener('pointerdown', (e) => e.stopPropagation())
    tip.innerHTML = `
      <div style="font-weight:600;font-size:12px;margin-bottom:6px;line-height:1.3;padding-right:${pinned ? '16px' : '0'}">${esc(c.concept_name)}</div>
      <table style="border-collapse:collapse;width:100%">
        ${row('Vocabulary', c.vocabulary_id)}
        ${row('ID', String(c.concept_id), true, pinned)}
        ${c.concept_code ? row('Code', c.concept_code, true, pinned) : ''}
        ${c.domain_id ? row('Domain', c.domain_id) : ''}
        ${c.concept_class_id ? row('Class', c.concept_class_id) : ''}
        ${badgeRow('Standard', stdBadge)}
        ${badgeRow('Valid', validBadge)}
      </table>
      ${pinned ? '<button class="ht-close" style="position:absolute;top:6px;right:8px;background:none;border:none;cursor:pointer;opacity:0.4;font-size:14px;line-height:1;padding:2px">✕</button>' : ''}
    `

    const canvasEl = canvasRef.current!
    const canvasRect = canvasEl.getBoundingClientRect()
    let tx = canvasRect.left + domPos.x + 14
    let ty = canvasRect.top + domPos.y + 14
    tip.style.left = tx + 'px'
    tip.style.top = ty + 'px'
    document.body.appendChild(tip)

    const tipRect = tip.getBoundingClientRect()
    if (tipRect.right > window.innerWidth - 10) tx = Math.max(10, canvasRect.left + domPos.x - tipRect.width - 14)
    if (tipRect.bottom > window.innerHeight - 10) ty = Math.max(10, canvasRect.top + domPos.y - tipRect.height - 14)
    tip.style.left = tx + 'px'
    tip.style.top = ty + 'px'

    if (pinned) {
      tip.querySelectorAll<HTMLButtonElement>('.ht-copy').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          void copyText(btn.dataset.copy ?? '').then((ok) => {
            if (!ok) return
            btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
            btn.style.opacity = '1'
            setTimeout(() => {
              btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
              btn.style.opacity = '0.5'
            }, 1200)
          })
        })
      })
      tip.querySelector<HTMLButtonElement>('.ht-close')?.addEventListener('click', (e) => {
        e.stopPropagation()
        setPinHighlight(null)
        pinnedIdRef.current = null
        hideTooltip()
      })
    }
  }, [hideTooltip, setPinHighlight])

  useEffect(() => {
    if (!canvasRef.current) return

    let cancelled = false
    let cleanup: (() => void) | undefined

    void (async () => {
      const { Network, DataSet } = await import('vis-network/standalone')
      // The effect may have been torn down (deps changed / unmounted) while the
      // chunk loaded, or the canvas unmounted — bail before touching the DOM.
      if (cancelled || !canvasRef.current) return
      cleanup = buildNetwork(Network, DataSet)
    })()

    return () => {
      cancelled = true
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self, ancestors, descendants, edgeRows, originId])

  // Builds the vis-network graph once its module has loaded; returns a cleanup.
  const buildNetwork = useCallback((
    Network: typeof import('vis-network/standalone').Network,
    DataSet: typeof import('vis-network/standalone').DataSet,
  ): (() => void) => {
    const canvas = canvasRef.current
    if (!canvas) return () => {}
    const isDark = document.documentElement.classList.contains('dark')
    const edgeCol = isDark ? '#4b5563' : '#9ca3af'
    const selfId = self.concept_id

    const colCurrent = { bg: isDark ? '#1d4ed8' : '#2563eb', border: isDark ? '#1e40af' : '#1d4ed8' }
    const colOrigin  = { bg: isDark ? '#c2410c' : '#ea580c', border: isDark ? '#9a3412' : '#c2410c' }
    const colOther   = { bg: isDark ? '#374151' : '#9ca3af', border: isDark ? '#4b5563' : '#6b7280' }

    const map = new Map<number, HierarchyConcept>()
    map.set(selfId, { ...self, hierarchy_level: 0 })
    ancestors.forEach((a) => map.set(a.concept_id, a))
    descendants.forEach((d) => map.set(d.concept_id, d))
    conceptMapRef.current = map

    const truncate = (s: string) => s.length > 30 ? s.slice(0, 28) + '…' : s

    const makeNode = (id: number, name: string, vocab: string, level: number, col: typeof colCurrent, bw: number) => {
      nodeColorsRef.current.set(id, { bg: col.bg, border: col.border, border2: bw })
      return {
        id, level,
        label: truncate(name) + '\n[' + vocab + ']',
        shape: 'box' as const,
        color: { background: col.bg, border: col.border, highlight: { background: col.bg, border: col.border } },
        font: { color: '#ffffff', size: 11 },
        widthConstraint: { minimum: 100, maximum: 200 },
        borderWidth: bw,
      }
    }

    nodeColorsRef.current = new Map()
    const nodesList = [
      makeNode(selfId, self.concept_name, self.vocabulary_id, 0, colCurrent, 2),
      ...ancestors.map((a) => makeNode(a.concept_id, a.concept_name, a.vocabulary_id, Number(a.hierarchy_level), a.concept_id === originId ? colOrigin : colOther, 1)),
      ...descendants.map((d) => makeNode(d.concept_id, d.concept_name, d.vocabulary_id, Number(d.hierarchy_level), d.concept_id === originId ? colOrigin : colOther, 1)),
    ]

    const edges = edgeRows.map((e) => ({
      from: e.from_id, to: e.to_id,
      arrows: 'to' as const,
      color: { color: edgeCol },
      smooth: { enabled: true, type: 'cubicBezier' as const, roundness: 0.5 },
    }))

    if (networkRef.current) networkRef.current.destroy()
    pinnedIdRef.current = null
    hideTooltip()

    const nodesDS = new DataSet(nodesList)
    nodesDataRef.current = nodesDS as unknown as DataSet<{ id: number; color: unknown; borderWidth: number; font?: unknown }>

    networkRef.current = new Network(
      canvas,
      { nodes: nodesDS, edges: new DataSet<Edge>(edges) },
      {
        layout: { hierarchical: { enabled: true, direction: 'UD', sortMethod: 'directed', levelSeparation: 60, nodeSpacing: 100 } },
        physics: false,
        interaction: {
          hover: true,
          // Zoom is ours (bindPinchZoom below): vis-network's own wheel zoom is
          // far more sensitive than the IDE figure viewer's, and ignores Safari pinch.
          zoomView: false,
          dragView: true,
          dragNodes: false,
          selectable: true,
          selectConnectedEdges: false,
          tooltipDelay: 99999,
          navigationButtons: false,
          keyboard: false,
        },
        nodes: { chosen: false },
        edges: { color: { color: edgeCol }, smooth: { enabled: true, type: 'cubicBezier', roundness: 0.5 } },
      }
    )

    const hoverShowRef = { t: null as ReturnType<typeof setTimeout> | null }
    const hoverHideRef = { t: null as ReturnType<typeof setTimeout> | null }

    networkRef.current.on('hoverNode', (params) => {
      clearTimeout(hoverShowRef.t ?? undefined)
      clearTimeout(hoverHideRef.t ?? undefined)
      const nodeId = Number(params.node)
      if (pinnedIdRef.current !== nodeId) applyHoverStyle(nodeId)
      if (pinnedIdRef.current !== null) return
      const domPos = params.pointer?.DOM ?? { x: 0, y: 0 }
      hoverShowRef.t = setTimeout(() => {
        if (pinnedIdRef.current !== null) return
        buildTooltip(nodeId, domPos, false)
      }, 250)
    })

    networkRef.current.on('blurNode', (params) => {
      clearTimeout(hoverShowRef.t ?? undefined)
      const nodeId = Number(params.node)
      if (pinnedIdRef.current !== nodeId) restoreStyle(nodeId)
      if (pinnedIdRef.current !== null) return
      hoverHideRef.t = setTimeout(() => {
        if (pinnedIdRef.current !== null) return
        if (!document.querySelector('.hierarchy-tooltip:hover')) hideTooltip()
      }, 150)
    })

    networkRef.current.on('click', (params) => {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current)
      const nodeId = params.nodes && params.nodes.length === 1 ? Number(params.nodes[0]) : null
      if (nodeId !== null) {
        if (pinnedIdRef.current === nodeId) {
          setPinHighlight(null)
          pinnedIdRef.current = null
          hideTooltip()
          return
        }
        // Apply pin style immediately — tooltip waits to avoid triggering on double-click
        setPinHighlight(nodeId)
        pinnedIdRef.current = nodeId
        const domPos = params.pointer?.DOM ?? { x: 0, y: 0 }
        clickTimeoutRef.current = setTimeout(() => {
          if (pinnedIdRef.current === nodeId) buildTooltip(nodeId, domPos, true)
        }, 280)
      } else {
        setPinHighlight(null)
        pinnedIdRef.current = null
        hideTooltip()
      }
    })

    networkRef.current.on('doubleClick', (params) => {
      if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current)
      const nodeId = params.nodes && params.nodes.length === 1
        ? Number(params.nodes[0])
        : networkRef.current?.getNodeAt(params.pointer.DOM) ?? null
      if (nodeId === null || nodeId === undefined) {
        networkRef.current?.fit({ animation: { duration: 350, easingFunction: 'easeInOutQuad' } })
      } else if (nodeId !== selfId) {
        pinnedIdRef.current = null
        hideTooltip()
        applyPinStyle(Number(nodeId))
        const c = conceptMapRef.current.get(Number(nodeId))
        if (c) requestAnimationFrame(() => onNavigate(Number(nodeId), c.concept_name))
      }
    })

    return () => {
      hideTooltip()
      networkRef.current?.destroy()
      networkRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [self, ancestors, descendants, edgeRows, originId])
  // ^ buildNetwork

  useEffect(() => {
    return () => hideTooltip()
  }, [hideTooltip])

  // Zoom around the pointer: keep the canvas point under it where it was.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    return bindPinchZoom(el, (factor, point) => {
      const net = networkRef.current
      if (!net) return
      const scale = clampScale(net.getScale() * factor, GRAPH_MIN_SCALE, GRAPH_MAX_SCALE)
      const anchor = net.DOMtoCanvas(point)
      const { width, height } = el.getBoundingClientRect()
      net.moveTo({
        scale,
        position: { x: anchor.x - (point.x - width / 2) / scale, y: anchor.y - (point.y - height / 2) / scale },
        animation: false,
      })
    })
  }, [])

  const zoom = (factor: number) => {
    if (!networkRef.current) return
    const s = networkRef.current.getScale()
    networkRef.current.moveTo({ scale: s * factor, animation: { duration: 250, easingFunction: 'easeInOutQuad' } })
  }
  const fit = () => networkRef.current?.fit({ animation: { duration: 350, easingFunction: 'easeInOutQuad' } })

  return (
    <div className="relative h-full w-full">
      <div ref={canvasRef} className="h-full w-full" />
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button type="button" title="Zoom in"   onClick={() => zoom(1.3)}     className="flex h-7 w-7 items-center justify-center rounded border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"><ZoomIn size={13} /></button>
        <button type="button" title="Zoom out"  onClick={() => zoom(1 / 1.3)} className="flex h-7 w-7 items-center justify-center rounded border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"><ZoomOut size={13} /></button>
        <button type="button" title="Fit"       onClick={fit}                  className="flex h-7 w-7 items-center justify-center rounded border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"><Expand size={13} /></button>
        <button type="button" title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => onFullscreenChange(!fullscreen)} className="flex h-7 w-7 items-center justify-center rounded border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground">
          {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
    </div>
  )
}
