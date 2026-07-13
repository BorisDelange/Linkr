import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Loader2, ArrowLeft, ZoomIn, ZoomOut, Maximize2, Minimize2, Expand } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RelationsTable, type RelationRow } from './RelationsTable'
// vis-network is ~1.4 MB; import it dynamically so it ships in its own chunk and
// loads only when the hierarchy graph actually renders (not with the whole page).
import type { Network, DataSet, Edge } from 'vis-network/standalone'
import { queryDataSource } from '@/lib/duckdb/engine'
import {
  buildConceptRelationsQuery,
  buildConceptAncestorsQuery,
  buildConceptDescendantsQuery,
  buildConceptEdgesQuery,
  buildConceptSelfQuery,
  buildConceptSynonymsQuery,
  buildConceptAncestorCountQuery,
  buildConceptDescendantCountQuery,
} from '@/lib/concept-mapping/concept-detail-queries'

const MIN_WIDTH = 400
const MAX_WIDTH = 1600
const DEFAULT_WIDTH = Math.round(window.innerWidth * 0.45)

export interface ConceptInfoTarget {
  concept_id: number
  concept_name: string
  concept_code?: string
  vocabulary_id?: string
  domain_id?: string
  concept_class_id?: string
  standard_concept?: string
  invalid_reason?: string
}

interface ConceptDetailSheetProps {
  target: ConceptInfoTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  dataSourceId: string | undefined
  conceptTable: string
}

// ---------------------------------------------------------------------------
// Detail row
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-medium text-right">{children}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hierarchy graph (vis-network)
// ---------------------------------------------------------------------------

type HierarchyConcept = {
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

const HIERARCHY_WARN_THRESHOLD = 100

function esc(s: string | number) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function HierarchyGraph({ self, ancestors, descendants, edgeRows, originId, onNavigate, fullscreen, onFullscreenChange }: HierarchyGraphProps) {
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
          navigator.clipboard.writeText(btn.dataset.copy ?? '').then(() => {
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
          zoomView: true,
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
      if (nodeId !== null && nodeId !== selfId) {
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConceptDetailSheet({ target, open, onOpenChange, dataSourceId, conceptTable }: ConceptDetailSheetProps) {
  const { t } = useTranslation()

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(DEFAULT_WIDTH)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [width])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + (startX.current - e.clientX))))
  }, [])
  const onPointerUp = useCallback(() => { dragging.current = false }, [])

  type SynonymRow = { concept_synonym_name: string; language_name?: string }
  type SelfRow = { concept_id: number; concept_name: string; vocabulary_id: string; domain_id?: string; concept_class_id?: string; concept_code?: string; standard_concept: string | null }

  const [relations, setRelations] = useState<RelationRow[]>([])
  const [synonyms, setSynonyms] = useState<SynonymRow[]>([])
  const [hierarchySelf, setHierarchySelf] = useState<SelfRow | null>(null)
  const [hierarchyAncestors, setHierarchyAncestors] = useState<HierarchyConcept[]>([])
  const [hierarchyDescendants, setHierarchyDescendants] = useState<HierarchyConcept[]>([])
  const [hierarchyEdges, setHierarchyEdges] = useState<{ from_id: number; to_id: number }[]>([])
  const [loadingRelations, setLoadingRelations] = useState(false)
  const [loadingHierarchy, setLoadingHierarchy] = useState(false)
  const [loadingSynonyms, setLoadingSynonyms] = useState(false)
  const [relationsUnavailable, setRelationsUnavailable] = useState(false)
  const [hierarchyUnavailable, setHierarchyUnavailable] = useState(false)
  const [synonymsUnavailable, setSynonymsUnavailable] = useState(false)
  const [activeTab, setActiveTab] = useState('details')

  const [hierarchyFullscreen, setHierarchyFullscreen] = useState(false)

  // Navigation stack: [{id, name}, ...], current = last
  const [hierarchyStack, setHierarchyStack] = useState<{ id: number; name: string }[]>([])
  // Pending navigation: held until load is confirmed (not blocked by warn)
  const pendingNavRef = useRef<{ id: number; name: string } | null>(null)
  const currentHierarchyId = hierarchyStack.length > 0 ? hierarchyStack[hierarchyStack.length - 1].id : target?.concept_id
  const currentHierarchyName = hierarchyStack.length > 0 ? hierarchyStack[hierarchyStack.length - 1].name : target?.concept_name

  // Large hierarchy warning
  const [hierarchyWarn, setHierarchyWarn] = useState<{ conceptId: number; total: number } | null>(null)

  // Reset on concept change
  useEffect(() => {
    setRelations([])
    setSynonyms([])
    setHierarchySelf(null)
    setHierarchyAncestors([])
    setHierarchyDescendants([])
    setHierarchyEdges([])
    setRelationsUnavailable(false)
    setHierarchyUnavailable(false)
    setSynonymsUnavailable(false)
    // Keep the user's current tab across concepts (don't force back to details) —
    // the per-tab reload effects below refetch the data for the new concept.
    setHierarchyStack([])
    setHierarchyWarn(null)
  }, [target?.concept_id])

  const doLoadHierarchyForId = useCallback(async (conceptId: number) => {
    if (!dataSourceId) return
    setLoadingHierarchy(true)
    setHierarchySelf(null)
    setHierarchyAncestors([])
    setHierarchyDescendants([])
    setHierarchyEdges([])
    setHierarchyWarn(null)
    setHierarchyUnavailable(false)
    try {
      const [selfRows, ancestorRows, descendantRows] = await Promise.all([
        queryDataSource(dataSourceId, buildConceptSelfQuery(conceptId, conceptTable)) as Promise<SelfRow[]>,
        queryDataSource(dataSourceId, buildConceptAncestorsQuery(conceptId, conceptTable)) as Promise<HierarchyConcept[]>,
        queryDataSource(dataSourceId, buildConceptDescendantsQuery(conceptId, conceptTable)) as Promise<HierarchyConcept[]>,
      ])

      const selfData = selfRows[0]
      if (!selfData) { setHierarchyUnavailable(true); return }

      const allIds = [
        conceptId,
        ...ancestorRows.map((a) => a.concept_id),
        ...descendantRows.map((d) => d.concept_id),
      ]

      const edgeRows = allIds.length > 1
        ? await queryDataSource(dataSourceId, buildConceptEdgesQuery(allIds)) as { from_id: number; to_id: number }[]
        : []

      setHierarchySelf({ ...selfData, hierarchy_level: 0 } as SelfRow)
      setHierarchyAncestors(ancestorRows)
      setHierarchyDescendants(descendantRows)
      setHierarchyEdges(edgeRows)
    } catch {
      setHierarchyUnavailable(true)
    } finally {
      setLoadingHierarchy(false)
    }
  }, [dataSourceId, conceptTable])

  const loadHierarchyForId = useCallback(async (conceptId: number, nav?: { id: number; name: string }) => {
    if (!dataSourceId) return
    try {
      const [ancRows, descRows] = await Promise.all([
        queryDataSource(dataSourceId, buildConceptAncestorCountQuery(conceptId)) as Promise<{ cnt: number }[]>,
        queryDataSource(dataSourceId, buildConceptDescendantCountQuery(conceptId)) as Promise<{ cnt: number }[]>,
      ])
      const total = Number(ancRows[0]?.cnt ?? 0) + Number(descRows[0]?.cnt ?? 0) + 1
      if (total > HIERARCHY_WARN_THRESHOLD) {
        pendingNavRef.current = nav ?? null
        setHierarchyWarn({ conceptId, total })
        return
      }
    } catch {
      // if count fails, proceed anyway
    }
    if (nav) setHierarchyStack((s) => [...s, nav])
    doLoadHierarchyForId(conceptId)
  }, [dataSourceId, doLoadHierarchyForId])

  // Load hierarchy when tab becomes active (no data yet) or stack navigates
  const loadHierarchyForIdRef = useRef(loadHierarchyForId)
  useEffect(() => { loadHierarchyForIdRef.current = loadHierarchyForId }, [loadHierarchyForId])

  useEffect(() => {
    if (activeTab !== 'hierarchy' || !target) return
    if (hierarchySelf) return
    loadHierarchyForIdRef.current(target.concept_id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, target?.concept_id])

  // Relations/synonyms are lazy (loaded on tab click), so when the concept changes
  // while one of those tabs stays active, refetch for the new concept — otherwise
  // the tab would show the just-cleared (empty) data. Mirrors the hierarchy effect.
  useEffect(() => {
    if (!target) return
    if (activeTab === 'relations' && relations.length === 0 && !relationsUnavailable && !loadingRelations) loadRelations()
    if (activeTab === 'synonyms' && synonyms.length === 0 && !synonymsUnavailable && !loadingSynonyms) loadSynonyms()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, target?.concept_id])

  const loadRelations = useCallback(async () => {
    if (!dataSourceId || !target) return
    setLoadingRelations(true)
    try {
      const rows = await queryDataSource(dataSourceId, buildConceptRelationsQuery(target.concept_id, conceptTable)) as unknown as RelationRow[]
      setRelations(rows)
    } catch {
      setRelationsUnavailable(true)
    } finally {
      setLoadingRelations(false)
    }
  }, [dataSourceId, target, conceptTable])

  const loadSynonyms = useCallback(async () => {
    if (!dataSourceId || !target) return
    setLoadingSynonyms(true)
    try {
      const rows = await queryDataSource(dataSourceId, buildConceptSynonymsQuery(target.concept_id)) as SynonymRow[]
      setSynonyms(rows)
    } catch (err) {
      // concept_synonym table may not exist — treat as unavailable, not an error
      setSynonymsUnavailable(true)
      if (err instanceof Error && !err.message.includes('concept_synonym')) {
        console.error(err)
      }
    } finally {
      setLoadingSynonyms(false)
    }
  }, [dataSourceId, target])

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab)
    if (tab === 'relations' && relations.length === 0 && !relationsUnavailable) loadRelations()
    if (tab === 'synonyms' && synonyms.length === 0 && !synonymsUnavailable) loadSynonyms()
    // hierarchy handled by useEffect above
  }, [relations.length, relationsUnavailable, synonyms.length, synonymsUnavailable, loadRelations, loadSynonyms])

  if (!target) return null

  const isStandard = target.standard_concept === 'S'
  const isClassification = target.standard_concept === 'C'
  const isValid = !target.invalid_reason

  const hierarchyEmpty = !loadingHierarchy && !hierarchyUnavailable && !hierarchySelf && !hierarchyWarn
  // While the hierarchy tab is active but the first load hasn't kicked in yet,
  // show the spinner instead of "no hierarchy" — the effect below will set
  // loadingHierarchy=true on the next tick.
  const hierarchyPendingFirstLoad = activeTab === 'hierarchy' && !loadingHierarchy && !hierarchySelf && !hierarchyUnavailable && !hierarchyWarn

  // originId for graph coloring: the concept we navigated from
  const originId = hierarchyStack.length >= 2
    ? hierarchyStack[hierarchyStack.length - 2].id
    : hierarchyStack.length === 1
    ? target.concept_id
    : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton
        style={{ width, maxWidth: MAX_WIDTH, minWidth: MIN_WIDTH }}
        className="flex flex-col p-0 gap-0"
      >
        <div
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 z-50"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-sm font-semibold leading-tight">{target.concept_name}</SheetTitle>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">#{target.concept_id}</span>
            {target.vocabulary_id && <Badge variant="outline" className="text-[10px]">{target.vocabulary_id}</Badge>}
            {isStandard && <Badge variant="default" className="bg-green-600 text-[10px]">{t('concept_mapping.concept_info_standard')}</Badge>}
            {isClassification && <Badge variant="secondary" className="text-[10px]">{t('concept_mapping.concept_info_classification')}</Badge>}
            {!isStandard && !isClassification && <Badge variant="outline" className="text-[10px] text-destructive border-destructive">{t('concept_mapping.concept_info_non_standard')}</Badge>}
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col flex-1 min-h-0">
          <TabsList variant="line" className="shrink-0 w-full justify-start rounded-none border-b px-3 mb-0">
            {(['details', 'relations', 'hierarchy', 'synonyms'] as const).map((tab) => (
              <TabsTrigger key={tab} value={tab} className="text-xs px-3">
                {t(`concept_mapping.concept_info_tab_${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Details */}
          <TabsContent value="details" className="flex-1 overflow-auto m-0">
            <ScrollArea className="h-full">
              <div className="px-4 py-3 space-y-1">
                {target.vocabulary_id && (
                  <DetailRow label={t('concept_mapping.col_vocabulary')}>{target.vocabulary_id}</DetailRow>
                )}
                <DetailRow label={t('concept_mapping.col_concept_id')}>
                  <span className="font-mono">{target.concept_id}</span>
                </DetailRow>
                <DetailRow label={t('concept_mapping.col_concept_name')}>{target.concept_name}</DetailRow>
                {target.concept_code && (
                  <DetailRow label={t('concept_mapping.col_concept_code')}><span className="font-mono">{target.concept_code}</span></DetailRow>
                )}
                {target.domain_id && (
                  <DetailRow label={t('concept_mapping.col_domain')}>{target.domain_id}</DetailRow>
                )}
                {target.concept_class_id && (
                  <DetailRow label={t('concept_mapping.col_concept_class')}>{target.concept_class_id}</DetailRow>
                )}
                <DetailRow label={t('concept_mapping.col_std')}>
                  {isStandard
                    ? <Badge variant="default" className="bg-green-600 text-[10px] px-1.5 py-0">{t('concept_mapping.concept_info_standard')}</Badge>
                    : isClassification
                    ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t('concept_mapping.concept_info_classification')}</Badge>
                    : <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-destructive border-destructive">{t('concept_mapping.concept_info_non_standard')}</Badge>}
                </DetailRow>
                <DetailRow label={t('concept_mapping.concept_info_validity')}>
                  {isValid
                    ? <Badge variant="default" className="bg-green-600 text-[10px] px-1.5 py-0">{t('concept_mapping.concept_info_valid')}</Badge>
                    : <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-destructive border-destructive">{target.invalid_reason ?? t('concept_mapping.concept_info_invalid')}</Badge>}
                </DetailRow>
                <div className="pt-2">
                  <a href={`https://athena.ohdsi.org/search-terms/terms/${target.concept_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <ExternalLink size={11} />{t('concept_mapping.concept_info_athena')}
                  </a>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Relations */}
          <TabsContent value="relations" className="flex-1 overflow-hidden m-0 flex flex-col min-h-0">
            {loadingRelations ? (
              <div className="flex h-20 items-center justify-center"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
            ) : relationsUnavailable ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
            ) : (
              <RelationsTable relations={relations} />
            )}
          </TabsContent>

          {/* Hierarchy */}
          <TabsContent value="hierarchy" className="flex-1 m-0 min-h-0 flex flex-col">
            <div className={hierarchyFullscreen ? 'fixed inset-0 z-[9998] bg-background flex flex-col' : 'flex flex-col flex-1 min-h-0'}>
              <div className="shrink-0 flex items-center gap-2 border-b px-3 py-1.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  disabled={hierarchyStack.length === 0}
                  onClick={() => {
                    const newStack = hierarchyStack.slice(0, -1)
                    setHierarchyStack(newStack)
                    const prevId = newStack.length > 0 ? newStack[newStack.length - 1].id : target.concept_id
                    doLoadHierarchyForId(prevId)
                  }}
                >
                  <ArrowLeft size={13} />
                </Button>
                <span className="truncate text-[11px] text-muted-foreground flex-1">
                  {currentHierarchyName ?? target.concept_name}
                </span>
                {hierarchyStack.length > 0 && (
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">#{currentHierarchyId}</span>
                )}
                {hierarchyFullscreen && (
                  <button
                    type="button"
                    onClick={() => setHierarchyFullscreen(false)}
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={t('common.close')}
                  >
                    <Minimize2 size={13} />
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 relative">
                {loadingHierarchy || hierarchyPendingFirstLoad ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 size={16} className="animate-spin text-muted-foreground" />
                  </div>
                ) : hierarchyUnavailable ? (
                  <p className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
                ) : hierarchyWarn ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-5 text-center shadow-sm max-w-[280px]">
                      <p className="text-sm font-medium">{t('concept_mapping.concept_info_hierarchy_large', { count: hierarchyWarn.total })}</p>
                      <p className="text-xs text-muted-foreground">{t('concept_mapping.concept_info_hierarchy_large_desc')}</p>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { pendingNavRef.current = null; setHierarchyWarn(null) }}>
                          {t('common.cancel')}
                        </Button>
                        <Button size="sm" className="h-7 text-xs" onClick={() => {
                          const nav = pendingNavRef.current
                          pendingNavRef.current = null
                          if (nav) setHierarchyStack((s) => [...s, nav])
                          doLoadHierarchyForId(hierarchyWarn!.conceptId)
                        }}>
                          {t('concept_mapping.concept_info_hierarchy_load_anyway')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : hierarchyEmpty ? (
                  <p className="flex h-full items-center justify-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_no_hierarchy')}</p>
                ) : hierarchySelf ? (
                  <HierarchyGraph
                    self={{ ...hierarchySelf, hierarchy_level: 0 } as HierarchyConcept}
                    ancestors={hierarchyAncestors}
                    descendants={hierarchyDescendants}
                    edgeRows={hierarchyEdges}
                    originId={originId}
                    onNavigate={(id, name) => loadHierarchyForId(id, { id, name })}
                    fullscreen={hierarchyFullscreen}
                    onFullscreenChange={setHierarchyFullscreen}
                  />
                ) : null}
              </div>
            </div>
          </TabsContent>

          {/* Synonyms */}
          <TabsContent value="synonyms" className="flex-1 overflow-hidden m-0">
            <ScrollArea className="h-full">
              {loadingSynonyms ? (
                <div className="flex h-20 items-center justify-center"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
              ) : synonymsUnavailable ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_table_unavailable')}</p>
              ) : synonyms.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">{t('concept_mapping.concept_info_no_synonyms')}</p>
              ) : (
                <ul className="divide-y px-4 py-2">
                  {synonyms.map((s, i) => (
                    <li key={i} className="py-1.5">
                      <p className="text-xs">{s.concept_synonym_name}</p>
                      {s.language_name && <p className="text-[10px] text-muted-foreground">{s.language_name}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
