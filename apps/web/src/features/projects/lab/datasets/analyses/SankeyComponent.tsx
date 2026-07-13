import { useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { sankey as d3Sankey, sankeyLinkHorizontal, type SankeyNode, type SankeyLink } from 'd3-sankey'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { Workflow, Table as TableIcon, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MultiSelectFilter } from '@/components/ui/multi-select-filter'
import { getLucideIcon, resolvePalette } from '@/lib/plugins/shared-styles'
import { isServerMode } from '@/lib/api-client'
import { renderOnServer } from '@/lib/api/execution'
import type { ComponentPluginProps } from '@/lib/plugins/component-registry'
import { buildSankeySpec } from './sankey-server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEmpty(val: unknown): boolean {
  if (val == null) return true
  const s = String(val).trim().toLowerCase()
  return s === '' || s === 'na' || s === 'nan' || s === 'null' || s === 'none'
}

function truncate(label: string, maxLen: number): string {
  return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label
}

/** A node identified by its stage label and its position (depth) in the flow.
 *  Position-keying turns cyclic pathways (Réa→Soins→Réa) into an acyclic left-to-right
 *  diagram: the returning "Réa" becomes a distinct node in a later column. */
interface NodeId { label: string; depth: number }
/** A counted source→target transition between two positioned nodes. */
interface LinkCount { source: NodeId; target: NodeId; value: number }

/** Shared column for every flow's terminal node when end-state alignment is on. Far beyond any
 *  real flow length so d3-sankey still places it last; same value for all terminals of a label
 *  collapses the per-depth duplicates into one final node. */
const TERMINAL_DEPTH = 1_000_000

/** A flow is an ordered list of stage labels. Build (source→target) link counts from many flows,
 *  keyed by (label, depth) so the diagram stays acyclic. Keyed on a tab separator internally so
 *  labels containing spaces survive intact, then returned as structured objects.
 *  When `alignEndStates` is set, each flow's terminal node is keyed by label only (a fixed
 *  terminal depth) so the same end state in flows of different lengths merges into one column. */
function buildLinks(flows: string[][], collapseRepeats: boolean, alignEndStates: boolean): LinkCount[] {
  const counts = new Map<string, number>()
  for (const flow of flows) {
    let steps = flow
    if (collapseRepeats) {
      steps = flow.filter((s, i) => i === 0 || s !== flow[i - 1])
    }
    for (let i = 0; i + 1 < steps.length; i++) {
      // depth = position of each endpoint in this flow (i → i+1); the terminal node is the
      // target of the last link, optionally pinned to a shared terminal column.
      const isLastLink = i + 2 === steps.length
      const targetDepth = alignEndStates && isLastLink ? TERMINAL_DEPTH : i + 1
      const key = `${i}\t${targetDepth}\t${steps[i]}\t${steps[i + 1]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return Array.from(counts, ([key, value]) => {
    const t1 = key.indexOf('\t')
    const t2 = key.indexOf('\t', t1 + 1)
    const t3 = key.indexOf('\t', t2 + 1)
    const sourceDepth = Number(key.slice(0, t1))
    const targetDepth = Number(key.slice(t1 + 1, t2))
    return {
      source: { label: key.slice(t2 + 1, t3), depth: sourceDepth },
      target: { label: key.slice(t3 + 1), depth: targetDepth },
      value,
    }
  })
}

/** Reconstruct one ordered flow per entity from long-format rows. */
function flowsFromLong(
  rows: Record<string, unknown>[],
  entityCol: string,
  stageCol: string,
  orderCol: string | null,
  excludeNA: boolean,
): string[][] {
  const groups = new Map<unknown, { stage: string; order: number; seq: number }[]>()
  let seq = 0
  for (const row of rows) {
    const entity = row[entityCol]
    if (entity == null) continue
    const stageVal = row[stageCol]
    if (excludeNA && isEmpty(stageVal)) continue
    const stage = String(stageVal ?? '')
    let order = seq
    if (orderCol) {
      const raw = row[orderCol]
      const n = typeof raw === 'number' ? raw : Number(raw)
      order = !isNaN(n) ? n : Date.parse(String(raw))
      if (isNaN(order)) order = seq
    }
    let list = groups.get(entity)
    if (!list) { list = []; groups.set(entity, list) }
    list.push({ stage, order, seq })
    seq++
  }
  const flows: string[][] = []
  for (const list of groups.values()) {
    // Stable sort by order, falling back to original row order on ties.
    list.sort((a, b) => (a.order - b.order) || (a.seq - b.seq))
    flows.push(list.map(s => s.stage))
  }
  return flows
}

/** One flow per row across the chosen level columns. */
function flowsFromLevels(
  rows: Record<string, unknown>[],
  levelCols: string[],
  excludeNA: boolean,
): string[][] {
  const flows: string[][] = []
  for (const row of rows) {
    const steps: string[] = []
    for (const col of levelCols) {
      const val = row[col]
      if (excludeNA && isEmpty(val)) continue
      steps.push(String(val ?? ''))
    }
    if (steps.length > 0) flows.push(steps)
  }
  return flows
}

/** One flow per row by splitting a path string on a separator. */
function flowsFromPath(
  rows: Record<string, unknown>[],
  pathCol: string,
  separator: string,
  excludeNA: boolean,
): string[][] {
  const sep = separator || ';'
  const flows: string[][] = []
  for (const row of rows) {
    const raw = row[pathCol]
    if (isEmpty(raw)) continue
    let steps = String(raw).split(sep).map(s => s.trim())
    if (excludeNA) steps = steps.filter(s => !isEmpty(s))
    if (steps.length > 0) flows.push(steps)
  }
  return flows
}

interface GraphNode { name: string; label: string }
interface GraphLink { source: number; target: number; value: number }
type LaidOutNode = SankeyNode<GraphNode, GraphLink>
type LaidOutLink = SankeyLink<GraphNode, GraphLink>

interface SankeyServerData {
  nodes: GraphNode[]
  links: GraphLink[]
  total: number
  error: null | 'missing'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SankeyComponent({ config, columns, rows, compact, datasetFileId, datasetFilters }: ComponentPluginProps) {
  const { t } = useTranslation()
  const server = isServerMode()

  const sourceMode = (config.sourceMode as string) ?? 'long'
  const displayMode = (config.displayMode as string) ?? 'diagram'
  const collapseRepeats = (config.collapseRepeats as boolean) ?? true
  const excludeNA = (config.excludeNA as boolean) ?? true
  const alignEndStates = (config.alignEndStates as boolean) ?? false
  const endNode = (config.addEndNode as string)?.trim() ?? ''
  const minLinkValue = Math.max(1, (config.minLinkValue as number) ?? 1)
  const maxLinkValue = Math.max(0, (config.maxLinkValue as number) ?? 0)
  const title = (config.title as string) ?? ''
  const centerTitle = (config.centerTitle as boolean) ?? true
  const cardIcon = (config.cardIcon as string) ?? '__none__'
  const valueDisplay = (config.valueDisplay as string) ?? 'none'
  const nodeWidth = (config.nodeWidth as number) ?? 16
  const nodePadding = (config.nodePadding as number) ?? 14
  const linkOpacity = ((config.linkOpacity as number) ?? 45) / 100
  const nodeLabelMaxLen = (config.nodeLabelMaxLen as number) ?? 22
  const linkColorMode = (config.linkColorMode as string) ?? 'source'
  const palette = resolvePalette((config.colorPalette as string) ?? 'default', (config.customPalette as string) ?? '')

  // Server mode: the backend reconstructs flows + counts links on the Parquet from
  // a validated spec (never client code). Stable string keys so the effect only
  // re-fetches on a semantic change.
  const spec = server && datasetFileId
    ? buildSankeySpec(columns, config)
    : null
  const specKey = spec ? JSON.stringify(spec) : null
  const filtersKey = JSON.stringify(datasetFilters ?? null)
  const [serverData, setServerData] = useState<SankeyServerData | null>(null)
  useEffect(() => {
    if (!server || !datasetFileId || !spec) return
    let cancelled = false
    renderOnServer('sankey', spec, { datasetFileId, datasetFilters })
      .then((out) => {
        if (cancelled) return
        if (out.stderr) { setServerData({ nodes: [], links: [], total: 0, error: null }); return }
        try { setServerData(JSON.parse(out.stdout.trim()) as SankeyServerData) }
        catch { setServerData({ nodes: [], links: [], total: 0, error: null }) }
      })
      .catch(() => { if (!cancelled) setServerData({ nodes: [], links: [], total: 0, error: null }) })
    return () => { cancelled = true }
  }, [server, datasetFileId, specKey, filtersKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Build flows then link counts ---
  const { nodes, links, total, error } = useMemo(() => {
    if (server) return serverData ?? { nodes: [] as GraphNode[], links: [] as GraphLink[], total: 0, error: null as null | 'missing' }
    let flows: string[][] = []
    if (sourceMode === 'long') {
      const entityCol = config.entityColumn as string
      const stageCol = config.stageColumn as string
      if (!entityCol || !stageCol) return { nodes: [], links: [], total: 0, error: 'missing' as const }
      const orderCol = (config.orderColumn as string) || null
      flows = flowsFromLong(rows, entityCol, stageCol, orderCol, excludeNA)
    } else if (sourceMode === 'levels') {
      const levelCols = (config.levelColumns as string[]) ?? []
      if (levelCols.length < 2) return { nodes: [], links: [], total: 0, error: 'missing' as const }
      flows = flowsFromLevels(rows, levelCols, excludeNA)
    } else {
      const pathCol = config.pathColumn as string
      if (!pathCol) return { nodes: [], links: [], total: 0, error: 'missing' as const }
      flows = flowsFromPath(rows, pathCol, (config.pathSeparator as string) ?? ';', excludeNA)
    }

    if (endNode) {
      flows = flows.map(f => (f.length > 0 ? [...f, endNode] : f))
    }

    const linkCounts = buildLinks(flows, collapseRepeats, alignEndStates)

    // Map (label, depth) → node indices, keeping only links at/above the threshold.
    // The internal node `name` encodes depth (so the same unit at two positions is two nodes),
    // while `label` is what the user sees.
    const indexOf = new Map<string, number>()
    const nodeList: GraphNode[] = []
    const linkList: GraphLink[] = []
    let total = 0
    const nodeIndex = (n: NodeId): number => {
      const key = `${n.depth}\t${n.label}`
      let i = indexOf.get(key)
      if (i == null) { i = nodeList.length; indexOf.set(key, i); nodeList.push({ name: key, label: n.label }) }
      return i
    }
    // A node that is never a link source is terminal (an exit state). Entry links leave the first
    // column (depth 0). The max-flow cap applies only to in-between transitions, so entry and exit
    // states always stay on the diagram even when their flows are large.
    const sourceKeys = new Set(linkCounts.map((l) => `${l.source.depth}\t${l.source.label}`))
    for (const { source, target, value } of linkCounts) {
      if (value < minLinkValue) continue
      const isEntryLink = source.depth === 0
      const isExitLink = !sourceKeys.has(`${target.depth}\t${target.label}`)
      if (maxLinkValue > 0 && value > maxLinkValue && !isEntryLink && !isExitLink) continue
      linkList.push({ source: nodeIndex(source), target: nodeIndex(target), value })
      total += value
    }

    return { nodes: nodeList, links: linkList, total, error: null as null | 'missing' }
  }, [server, serverData, config, rows, sourceMode, collapseRepeats, excludeNA, endNode, minLinkValue, maxLinkValue, alignEndStates])

  // --- Responsive sizing ---
  // The chart container only mounts once the config is valid (the placeholder branch has no SVG host).
  // A callback ref re-attaches the observer whenever that element mounts, so a preview whose config
  // arrives after first render still gets measured — a plain useEffect with [] deps would miss it.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; value: string } | null>(null)
  const [hoveredLink, setHoveredLink] = useState<number | null>(null)
  // In "both-tabs" mode, which of the two views is showing (local, not persisted to config).
  const [activeView, setActiveView] = useState<'diagram' | 'table'>('diagram')
  // Clicking a link in a diagram+table layout briefly highlights the matching table row, then it
  // fades. `flashKey` is the matched "source\ttarget"; `flashNonce` re-triggers the flash when the
  // same link is clicked twice in a row. A timer clears the key so the row fades back.
  const [flash, setFlash] = useState<{ key: string; nonce: number } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashRowRef = useRef<HTMLTableRowElement | null>(null)
  // Table sort + per-column factor filters (From/To). Default sort: biggest flow first — the most
  // useful reading order for a Sankey (the dominant transitions on top).
  const [sort, setSort] = useState<{ col: 'source' | 'target' | 'value' | 'percent'; dir: 'asc' | 'desc' }>({ col: 'value', dir: 'desc' })
  const [fromFilter, setFromFilter] = useState<string[]>([])
  const [toFilter, setToFilter] = useState<string[]>([])
  const setContainer = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    containerRef.current = el
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    observerRef.current = ro
  }, [])

  // --- Run the d3-sankey layout ---
  const graph = useMemo(() => {
    if (nodes.length === 0 || links.length === 0 || size.width < 40 || size.height < 40) return null
    const margin = { top: 6, right: 4, bottom: 6, left: 4 }
    const innerW = size.width - margin.left - margin.right
    const innerH = size.height - margin.top - margin.bottom
    try {
      const layout = d3Sankey<GraphNode, GraphLink>()
        .nodeWidth(nodeWidth)
        .nodePadding(nodePadding)
        .extent([[margin.left, margin.top], [margin.left + innerW, margin.top + innerH]])
      return layout({
        nodes: nodes.map(n => ({ ...n })),
        links: links.map(l => ({ ...l })),
      })
    } catch {
      // Position-keyed nodes make the graph acyclic, but guard defensively in case
      // d3-sankey still rejects a degenerate input rather than crashing the dashboard.
      return null
    }
  }, [nodes, links, size, nodeWidth, nodePadding])

  // Assign a stable color per distinct label (so the same unit keeps one color across columns).
  const colorMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) {
      if (!m.has(n.label)) m.set(n.label, palette[m.size % palette.length])
    }
    return m
  }, [nodes, palette])
  const colorFor = (label: string) => colorMap.get(label) ?? palette[0]

  // Flat list of transitions for the table display.
  const tableRows = useMemo(
    () => links.map((l) => ({ source: nodes[l.source]?.label ?? '', target: nodes[l.target]?.label ?? '', value: l.value })),
    [links, nodes],
  )

  // Distinct From / To values for the column dropdown filters (sorted alphabetically).
  const fromOptions = useMemo(
    () => Array.from(new Set(tableRows.map((r) => r.source))).sort((a, b) => a.localeCompare(b)),
    [tableRows],
  )
  const toOptions = useMemo(
    () => Array.from(new Set(tableRows.map((r) => r.target))).sort((a, b) => a.localeCompare(b)),
    [tableRows],
  )

  // Apply the factor filters, then sort by the active column. Ties fall back to count desc so the
  // order stays stable and meaningful when sorting by a label column.
  const displayedRows = useMemo(() => {
    const fromSet = new Set(fromFilter)
    const toSet = new Set(toFilter)
    const filtered = tableRows.filter(
      (r) => (fromSet.size === 0 || fromSet.has(r.source)) && (toSet.size === 0 || toSet.has(r.target)),
    )
    const factor = sort.dir === 'asc' ? 1 : -1
    return filtered.sort((a, b) => {
      let cmp: number
      // Count and % share the same numeric basis (% is value/total), so both sort by value.
      if (sort.col === 'value' || sort.col === 'percent') cmp = a.value - b.value
      else cmp = a[sort.col].localeCompare(b[sort.col])
      return cmp !== 0 ? cmp * factor : b.value - a.value
    })
  }, [tableRows, fromFilter, toFilter, sort])

  const toggleSort = useCallback((col: 'source' | 'target' | 'value' | 'percent') => {
    setSort((prev) => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      // New column: labels default ascending (A→Z), the numeric columns default descending.
      : { col, dir: col === 'value' || col === 'percent' ? 'desc' : 'asc' })
  }, [])

  const formatValue = (v: number): string => {
    if (valueDisplay === 'percent') {
      return total > 0 ? `${((v / total) * 100).toFixed(1)}%` : ''
    }
    return v.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
  }

  // Always show both count and percent in the tooltip, regardless of the on-chart value-label setting.
  const tooltipValue = (v: number): string => {
    const count = v.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })
    const pct = total > 0 ? ` (${((v / total) * 100).toFixed(1)}%)` : ''
    return count + pct
  }

  const showTip = (e: React.MouseEvent, title: string, value: string) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, title, value })
  }

  // Both-views layouts let a link click point at its table row. Flash that row, then clear after a
  // beat so it fades back. In the tabbed layout, switch to the table so the highlighted row shows.
  const showsTable = displayMode === 'both' || displayMode === 'both-tabs'
  const flashLink = useCallback((source: string, target: string) => {
    if (displayMode === 'both-tabs') setActiveView('table')
    // If the matching row is hidden by the current factor filters, clear them so the flash is
    // visible — clicking a link should always reveal its transition.
    setFromFilter((from) => (from.length > 0 && !from.includes(source) ? [] : from))
    setToFilter((to) => (to.length > 0 && !to.includes(target) ? [] : to))
    if (flashTimer.current) clearTimeout(flashTimer.current)
    setFlash((prev) => ({ key: `${source}\t${target}`, nonce: (prev?.nonce ?? 0) + 1 }))
    flashTimer.current = setTimeout(() => setFlash(null), 1600)
  }, [displayMode])

  // Clicking a node toggles the table's From filter on that node's label (the flows leaving it):
  // first click filters to it, clicking the same node again clears the filter.
  const filterFrom = useCallback((label: string) => {
    if (displayMode === 'both-tabs') setActiveView('table')
    setFromFilter((prev) => (prev.length === 1 && prev[0] === label ? [] : [label]))
  }, [displayMode])
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
  // Bring the flashed row into view (it may be scrolled off in the stacked layout). Keyed on the
  // nonce so re-clicking the same link re-scrolls.
  const flashNonce = flash?.nonce
  useEffect(() => {
    if (flashNonce != null) flashRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [flashNonce])

  // Diagram/table switch for "both-tabs" mode — shown centered on its own line below the title.
  const tabBtn = (view: 'diagram' | 'table', label: string) => (
    <button
      type="button"
      onClick={() => setActiveView(view)}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
        activeView === view ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {view === 'diagram' ? <Workflow size={12} /> : <TableIcon size={12} />}
      {label}
    </button>
  )
  const viewTabs = displayMode === 'both-tabs' ? (
    <div className={cn('flex shrink-0 items-center justify-center gap-1', compact ? 'px-4 pb-1' : 'mb-2')}>
      {tabBtn('diagram', t('plugins.sankey.view_diagram', 'Diagram'))}
      {tabBtn('table', t('plugins.sankey.view_table', 'Table'))}
    </div>
  ) : null

  // --- Header (matches PlotBuilder card pattern) ---
  const hasIcon = cardIcon !== '__none__' && cardIcon !== ''
  const Icon = hasIcon ? getLucideIcon(cardIcon) : null
  const header = (Icon || title) ? (
    <div className={cn('flex items-center gap-2', compact ? 'px-4 pt-3 pb-1' : 'mb-2', centerTitle && 'justify-center')}>
      {/* eslint-disable-next-line react-hooks/static-components -- dynamic component resolved from data */}
      {Icon && <Icon size={compact ? 16 : 18} className="text-muted-foreground" />}
      {title && <span className="text-xs font-medium truncate text-muted-foreground">{title}</span>}
    </div>
  ) : null

  let body: React.ReactNode
  if (error === 'missing') {
    body = (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground text-center px-4">
        {t('plugins.sankey.configure', 'Choose the columns that describe each flow to build the diagram.')}
      </div>
    )
  } else if (nodes.length === 0 || links.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground text-center px-4">
        {t('plugins.sankey.no_flows', 'No flows to display with the current settings.')}
      </div>
    )
  } else {
    const diagram = (
      <div ref={setContainer} className="relative w-full h-full">
        {graph && (
          <svg width={size.width} height={size.height} className="overflow-visible">
            <g>
              {(graph.links as LaidOutLink[]).map((link, i) => {
                const src = link.source as LaidOutNode
                const tgt = link.target as LaidOutNode
                const stroke = linkColorMode === 'gray'
                  ? 'var(--color-muted-foreground, #94a3b8)'
                  : colorFor((linkColorMode === 'target' ? tgt.label : src.label))
                const onMove = (e: React.MouseEvent) =>
                  showTip(e, `${src.label} → ${tgt.label}`, tooltipValue(link.value))
                return (
                  <path
                    key={i}
                    d={sankeyLinkHorizontal()(link) ?? undefined}
                    fill="none"
                    stroke={stroke}
                    strokeOpacity={hoveredLink === i ? Math.min(1, linkOpacity + 0.25) : linkOpacity}
                    strokeWidth={Math.max(1, link.width ?? 1)}
                    className={cn('transition-[stroke-opacity] duration-100', showsTable && 'cursor-pointer')}
                    onMouseMove={e => { setHoveredLink(i); onMove(e) }}
                    onMouseLeave={() => { setHoveredLink(null); setTooltip(null) }}
                    onClick={showsTable ? () => flashLink(src.label, tgt.label) : undefined}
                  />
                )
              })}
            </g>
            <g>
              {(graph.nodes as LaidOutNode[]).map((node, i) => {
                const x0 = node.x0 ?? 0
                const x1 = node.x1 ?? 0
                const y0 = node.y0 ?? 0
                const y1 = node.y1 ?? 0
                const h = y1 - y0
                const fill = colorFor(node.label)
                // Place labels left of right-edge nodes, right of all others, to keep them inside.
                const atRightEdge = x1 > size.width - 60
                const onMove = (e: React.MouseEvent) =>
                  showTip(e, node.label, tooltipValue(node.value ?? 0))
                return (
                  <g key={i}>
                    <rect
                      x={x0}
                      y={y0}
                      width={x1 - x0}
                      height={Math.max(1, h)}
                      fill={fill}
                      rx={1.5}
                      className={cn(showsTable && 'cursor-pointer')}
                      onMouseMove={onMove}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={showsTable ? () => filterFrom(node.label) : undefined}
                    />
                    {h >= 8 && (
                      <text
                        x={atRightEdge ? x0 - 5 : x1 + 5}
                        y={(y0 + y1) / 2}
                        dy="0.35em"
                        textAnchor={atRightEdge ? 'end' : 'start'}
                        className="fill-foreground pointer-events-none"
                        style={{ fontSize: compact ? 9 : 11 }}
                      >
                        {truncate(node.label, nodeLabelMaxLen)}
                        {valueDisplay !== 'none' && (
                          <tspan className="fill-muted-foreground"> ({formatValue(node.value ?? 0)})</tspan>
                        )}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        )}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 rounded-md bg-black/85 px-2 py-1 text-white shadow-lg"
            style={{
              left: tooltip.x,
              top: tooltip.y,
              transform: `translate(${tooltip.x > size.width - 160 ? '-100%' : '12px'}, -50%)`,
            }}
          >
            <div className="text-[11px] font-medium leading-tight whitespace-nowrap">{tooltip.title}</div>
            <div className="text-[10px] leading-tight text-white/75 whitespace-nowrap">{tooltip.value}</div>
          </div>
        )}
      </div>
    )

    const sortIcon = (col: 'source' | 'target' | 'value' | 'percent') =>
      sort.col !== col
        ? <ChevronsUpDown size={11} className="opacity-40" />
        : sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
    const sortBtnClass = 'flex items-center gap-1 font-medium hover:text-foreground'
    const table = (
      <div className="flex h-full flex-col overflow-hidden px-3 pb-3">
        <div className="overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-muted-foreground align-bottom">
                <th className="py-1 pr-2 text-left">
                  <button type="button" onClick={() => toggleSort('source')} className={sortBtnClass}>
                    {t('plugins.sankey.table_from', 'From')}{sortIcon('source')}
                  </button>
                  <div className="mt-1 max-w-[10rem] font-normal">
                    <MultiSelectFilter
                      value={fromFilter}
                      options={fromOptions}
                      placeholder={t('plugins.sankey.filter_all', 'All')}
                      onChange={setFromFilter}
                    />
                  </div>
                </th>
                <th className="py-1 px-2 text-left">
                  <button type="button" onClick={() => toggleSort('target')} className={sortBtnClass}>
                    {t('plugins.sankey.table_to', 'To')}{sortIcon('target')}
                  </button>
                  <div className="mt-1 max-w-[10rem] font-normal">
                    <MultiSelectFilter
                      value={toFilter}
                      options={toOptions}
                      placeholder={t('plugins.sankey.filter_all', 'All')}
                      onChange={setToFilter}
                    />
                  </div>
                </th>
                <th className="py-1 pl-2 text-right">
                  <button type="button" onClick={() => toggleSort('value')} className={cn(sortBtnClass, 'ml-auto')}>
                    {t('plugins.sankey.table_count', 'Count')}{sortIcon('value')}
                  </button>
                </th>
                <th className="py-1 pl-2 text-right">
                  <button type="button" onClick={() => toggleSort('percent')} className={cn(sortBtnClass, 'ml-auto')}>
                    %{sortIcon('percent')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((r, i) => {
                const isFlashed = flash?.key === `${r.source}\t${r.target}`
                return (
                  <tr
                    key={i}
                    ref={isFlashed ? flashRowRef : undefined}
                    className={cn(
                      'border-t border-border/50 [&>td]:transition-colors [&>td]:duration-700',
                      isFlashed && '[&>td]:bg-primary/20',
                    )}
                  >
                    <td className="py-1 pr-2">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 shrink-0 rounded-sm" style={{ background: colorFor(r.source) }} />
                        <span className="truncate">{r.source}</span>
                      </span>
                    </td>
                    <td className="py-1 px-2 truncate">{r.target}</td>
                    <td className="py-1 pl-2 text-right tabular-nums">{r.value.toLocaleString(undefined, { useGrouping: true, maximumFractionDigits: 0 })}</td>
                    <td className="py-1 pl-2 text-right tabular-nums text-muted-foreground">{total > 0 ? `${((r.value / total) * 100).toFixed(1)}%` : ''}</td>
                  </tr>
                )
              })}
              {displayedRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-center text-muted-foreground">
                    {t('plugins.sankey.no_rows', 'No rows match the filters.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    )

    if (displayMode === 'table') {
      body = table
    } else if (displayMode === 'both') {
      // Diagram above, table below, with a draggable divider to rebalance the two panes. The
      // table pane carries the visible separator (a full-width top border) since Allotment's own
      // separator line is hidden behind the pane content; its sash still drives the resize on top.
      body = (
        <Allotment vertical>
          <Allotment.Pane minSize={80}>{diagram}</Allotment.Pane>
          <Allotment.Pane minSize={80} preferredSize="40%">
            <div className="h-full border-t border-border">{table}</div>
          </Allotment.Pane>
        </Allotment>
      )
    } else if (displayMode === 'both-tabs') {
      // Both views available; the diagram/table switch is the centered strip below the title (viewTabs).
      body = activeView === 'table' ? table : diagram
    } else {
      body = diagram
    }
  }

  if (compact) {
    return (
      <div className="flex h-full flex-col">
        {header}
        {viewTabs}
        <div className="flex-1 min-h-0 px-2 pb-2">{body}</div>
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col p-4 gap-2">
      {header}
      {viewTabs}
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  )
}
