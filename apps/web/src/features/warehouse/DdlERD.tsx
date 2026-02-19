import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Table2, Pencil, Check, Palette, RotateCcw, Filter, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { ErdGroup } from '@/types/schema-mapping'
import { DdlERDGroupPanel } from './DdlERDGroupPanel'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedColumn {
  name: string
  type: string
  nullable: boolean
  isPk: boolean
}

export interface ParsedTable {
  name: string
  columns: ParsedColumn[]
  pkColumns: string[]
  fks: { columns: string[]; refTable: string; refColumns: string[] }[]
}

interface DdlNodeData {
  [key: string]: unknown
  label: string
  columns: ParsedColumn[]
  fks: ParsedTable['fks']
}

interface DdlGroupNodeData {
  [key: string]: unknown
  label: string
  color: string
  groupId: string
}

// ---------------------------------------------------------------------------
// DDL Parser
// ---------------------------------------------------------------------------

export function parseDdl(ddl: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?(?:"?(\w+)"?)\s*\(([\s\S]*?)\);/gi
  let match

  while ((match = tableRegex.exec(ddl)) !== null) {
    const tableName = match[2] || match[1]
    if (!tableName) continue

    const body = match[3]
    const columns: ParsedColumn[] = []
    const pkColumns: string[] = []
    const fks: ParsedTable['fks'] = []

    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '')
      if (!trimmed) continue

      // Table-level PRIMARY KEY constraint
      const pkMatch = trimmed.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i)
      if (pkMatch) {
        pkMatch[1].split(',').forEach((c) => {
          const col = c.trim().replace(/"/g, '')
          if (col && !pkColumns.includes(col)) pkColumns.push(col)
        })
        continue
      }

      // Table-level FOREIGN KEY constraint
      const fkMatch = trimmed.match(
        /^(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+"?(\w+)"?\s*\(([^)]+)\)/i,
      )
      if (fkMatch) {
        fks.push({
          columns: fkMatch[1].split(',').map((c) => c.trim().replace(/"/g, '')),
          refTable: fkMatch[2],
          refColumns: fkMatch[3].split(',').map((c) => c.trim().replace(/"/g, '')),
        })
        continue
      }

      // Skip other constraints
      if (/^(CONSTRAINT|UNIQUE|CHECK|INDEX)/i.test(trimmed)) continue

      // Column definition
      const colMatch = trimmed.match(/^"?(\w+)"?\s+(\w+(?:\s*\([^)]*\))?)\s*(NOT\s+NULL\s*)?(NULL\s*)?(PRIMARY\s+KEY)?/i)
      if (colMatch) {
        const colName = colMatch[1]
        const colType = colMatch[2].trim()
        const notNull = !!colMatch[3]
        const isPk = !!colMatch[5]

        columns.push({ name: colName, type: colType, nullable: !notNull && !isPk, isPk })
        if (isPk && !pkColumns.includes(colName)) pkColumns.push(colName)
      }
    }

    // Mark columns as PK from table-level constraint
    for (const col of columns) {
      if (pkColumns.includes(col.name)) col.isPk = true
    }

    tables.push({ name: tableName, columns, pkColumns, fks })
  }

  // Build lookup for ALTER TABLE statements
  const tableMap = new Map<string, ParsedTable>()
  for (const t of tables) tableMap.set(t.name.toLowerCase(), t)

  // Parse ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY (col1, col2)
  const alterPkRegex = /ALTER\s+TABLE\s+(?:"?(\w+)"?\.)?(?:"?(\w+)"?)\s+ADD\s+CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)/gi
  while ((match = alterPkRegex.exec(ddl)) !== null) {
    const tName = (match[2] || match[1])?.toLowerCase()
    if (!tName) continue
    const table = tableMap.get(tName)
    if (!table) continue
    for (const raw of match[3].split(',')) {
      const col = raw.trim().replace(/"/g, '')
      if (col && !table.pkColumns.includes(col)) table.pkColumns.push(col)
      const colDef = table.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())
      if (colDef) colDef.isPk = true
    }
  }

  // Parse ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (col) REFERENCES refTable (refCol)
  const alterFkRegex = /ALTER\s+TABLE\s+(?:"?(\w+)"?\.)?(?:"?(\w+)"?)\s+ADD\s+CONSTRAINT\s+\w+\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:"?(\w+)"?\.)?(?:"?(\w+)"?)\s*\(([^)]+)\)/gi
  while ((match = alterFkRegex.exec(ddl)) !== null) {
    const tName = (match[2] || match[1])?.toLowerCase()
    if (!tName) continue
    const table = tableMap.get(tName)
    if (!table) continue
    const refTable = match[5] || match[4]
    if (!refTable) continue
    table.fks.push({
      columns: match[3].split(',').map((c) => c.trim().replace(/"/g, '')),
      refTable: refTable.toLowerCase(),
      refColumns: match[6].split(',').map((c) => c.trim().replace(/"/g, '')),
    })
  }

  return tables
}

// ---------------------------------------------------------------------------
// Group color palette
// ---------------------------------------------------------------------------

const GROUP_COLORS: Record<string, { bg: string; border: string; text: string; bgSelected: string }> = {
  blue:   { bg: 'bg-blue-500/6',   border: 'border-blue-300/40',   text: 'text-blue-700 dark:text-blue-300',   bgSelected: 'bg-blue-500/12'   },
  green:  { bg: 'bg-green-500/6',  border: 'border-green-300/40',  text: 'text-green-700 dark:text-green-300',  bgSelected: 'bg-green-500/12'  },
  orange: { bg: 'bg-orange-500/6', border: 'border-orange-300/40', text: 'text-orange-700 dark:text-orange-300', bgSelected: 'bg-orange-500/12' },
  purple: { bg: 'bg-purple-500/6', border: 'border-purple-300/40', text: 'text-purple-700 dark:text-purple-300', bgSelected: 'bg-purple-500/12' },
  teal:   { bg: 'bg-teal-500/6',   border: 'border-teal-300/40',   text: 'text-teal-700 dark:text-teal-300',   bgSelected: 'bg-teal-500/12'   },
  red:    { bg: 'bg-red-500/6',    border: 'border-red-300/40',    text: 'text-red-700 dark:text-red-300',    bgSelected: 'bg-red-500/12'    },
  slate:  { bg: 'bg-slate-500/6',  border: 'border-slate-300/40',  text: 'text-slate-600 dark:text-slate-400',  bgSelected: 'bg-slate-500/12'  },
}

// ---------------------------------------------------------------------------
// Custom nodes
// ---------------------------------------------------------------------------

const ROLE_BADGES: Record<string, string> = {
  pk: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200',
  fk: 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200',
}

function DdlTableNode({ data }: NodeProps<Node<DdlNodeData>>) {
  // Build FK lookup: column name → "refTable.refColumn"
  const fkMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const fk of data.fks ?? []) {
      for (let i = 0; i < fk.columns.length; i++) {
        map.set(fk.columns[i], `${fk.refTable}.${fk.refColumns[i]}`)
      }
    }
    return map
  }, [data.fks])

  return (
    <TooltipProvider>
      <div className="rounded-lg border-2 shadow-lg bg-card border-border" style={{ width: 260 }}>
        <div className="flex items-center gap-2 rounded-t-md px-3 py-2 bg-muted/60">
          <Table2 size={13} className="text-muted-foreground shrink-0" />
          <span className="text-xs font-bold text-foreground truncate">{data.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">{data.columns.length}</span>
        </div>
        <div className="px-2 py-1.5 space-y-px">
          {data.columns.map((col) => {
            const isPk = col.isPk
            const fkTarget = fkMap.get(col.name)
            const isFk = !!fkTarget

            const row = (
              <div className="flex items-center gap-1 relative py-px">
                {isPk || isFk ? (
                  <span className={`inline-flex items-center justify-center rounded min-w-[22px] px-0.5 text-center text-[7px] font-bold uppercase leading-none py-0.5 ${isPk ? ROLE_BADGES.pk : ROLE_BADGES.fk}`}>
                    {isPk ? 'PK' : 'FK'}
                  </span>
                ) : (
                  <span className="min-w-[22px]" />
                )}
                <code className="text-[10px] text-foreground/80 font-mono truncate flex-1">{col.name}</code>
                <span className="text-[9px] text-muted-foreground/60 font-mono shrink-0">{col.type.toLowerCase()}</span>
                {isPk && (
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={`pk-${col.name}`}
                    className="!w-2 !h-2 !bg-yellow-500 !border-[1px] !border-background !left-[-9px]"
                  />
                )}
                {isFk && (
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`fk-${col.name}`}
                    className="!w-2 !h-2 !bg-blue-500 !border-[1px] !border-background !right-[-9px]"
                  />
                )}
              </div>
            )

            if (!isPk && !isFk) return <div key={col.name}>{row}</div>

            return (
              <Tooltip key={col.name}>
                <TooltipTrigger asChild>{row}</TooltipTrigger>
                <TooltipContent side={isFk ? 'right' : 'left'} sideOffset={12}>
                  <div className="space-y-0.5">
                    <div className="font-mono font-semibold">{col.name}</div>
                    <div className="font-mono text-[10px] opacity-70">{col.type}{col.nullable ? '' : ' NOT NULL'}</div>
                    {isPk && <div className="text-yellow-300 text-[10px]">Primary Key</div>}
                    {isFk && <div className="text-blue-300 text-[10px]">FK &rarr; {fkTarget}</div>}
                  </div>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </div>
    </TooltipProvider>
  )
}

function DdlGroupNode({ data, selected }: NodeProps<Node<DdlGroupNodeData>>) {
  const colors = GROUP_COLORS[data.color] ?? GROUP_COLORS.slate
  return (
    <div
      className={`rounded-xl border-2 transition-all ${colors.border} ${selected ? colors.bgSelected : colors.bg}`}
      style={{ width: '100%', height: '100%', minWidth: 200, minHeight: 120 }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className={`text-xs font-semibold ${colors.text}`}>{data.label}</span>
      </div>
    </div>
  )
}

const nodeTypes = { ddlTable: DdlTableNode, ddlGroup: DdlGroupNode }

// ---------------------------------------------------------------------------
// Build graph with group-aware layout
// ---------------------------------------------------------------------------

const NODE_W = 290
const NODE_GAP_X = 30
const NODE_GAP_Y = 30
const GROUP_PADDING_TOP = 40
const GROUP_PADDING = 20

function estimateHeight(colCount: number) {
  return 36 + colCount * 18 + 12
}

function sortParentsFirst(nodes: Node[]): Node[] {
  const parentIds = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId!))
  const parents = nodes.filter((n) => parentIds.has(n.id))
  const others = nodes.filter((n) => !parentIds.has(n.id))
  return [...parents, ...others]
}

interface BuildGraphOpts {
  tables: ParsedTable[]
  erdGroups?: ErdGroup[]
  erdLayout?: Record<string, { x: number; y: number }>
  /** Table names to hide from the diagram. */
  hiddenTables?: Set<string>
}

function buildDdlGraph({ tables: allTables, erdGroups, erdLayout, hiddenTables }: BuildGraphOpts): { nodes: Node[]; edges: Edge[] } {
  const tables = hiddenTables ? allTables.filter((t) => !hiddenTables.has(t.name.toLowerCase())) : allTables
  const nodes: Node[] = []

  // Build table name → group lookup (case-insensitive)
  const tableGroupMap = new Map<string, ErdGroup>()
  for (const group of erdGroups ?? []) {
    for (const t of group.tables) {
      tableGroupMap.set(t.toLowerCase(), group)
    }
  }

  const hasLayout = erdLayout && Object.keys(erdLayout).length > 0
  const groups = erdGroups ?? []

  if (hasLayout) {
    // --- Saved layout mode: use absolute positions ---

    // Create table nodes first to compute group bounding boxes
    const tableNodes: Node[] = []
    for (const t of tables) {
      const pos = erdLayout[t.name] ?? erdLayout[t.name.toLowerCase()]
      tableNodes.push({
        id: t.name,
        type: 'ddlTable',
        position: pos ?? { x: 0, y: 0 },
        data: { label: t.name, columns: t.columns, fks: t.fks } as DdlNodeData,
      })
    }

    // Create group nodes from bounding boxes of their children
    for (const group of groups) {
      const groupTableNames = new Set(group.tables.map((t) => t.toLowerCase()))
      const children = tableNodes.filter((n) => groupTableNames.has(n.id.toLowerCase()))
      if (children.length === 0) continue

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const child of children) {
        const t = tables.find((tt) => tt.name === child.id)
        const h = t ? estimateHeight(t.columns.length) : 100
        minX = Math.min(minX, child.position.x)
        minY = Math.min(minY, child.position.y)
        maxX = Math.max(maxX, child.position.x + NODE_W)
        maxY = Math.max(maxY, child.position.y + h)
      }
      if (minX === Infinity) continue

      const gx = minX - GROUP_PADDING
      const gy = minY - GROUP_PADDING_TOP
      const gw = maxX - minX + GROUP_PADDING * 2
      const gh = maxY - minY + GROUP_PADDING_TOP + GROUP_PADDING

      nodes.push({
        id: `group-${group.id}`,
        type: 'ddlGroup',
        position: { x: gx, y: gy },
        data: { label: group.label, color: group.color, groupId: group.id } as DdlGroupNodeData,
        style: { width: gw, height: gh },
      })

      // Convert child positions to relative
      for (const child of children) {
        child.parentId = `group-${group.id}`
        child.expandParent = true
        child.position = {
          x: child.position.x - gx,
          y: child.position.y - gy,
        }
      }
    }

    nodes.push(...tableNodes)
  } else {
    // --- Auto-layout mode: arrange tables within groups ---

    const groupedTableNames = new Set<string>()
    for (const g of groups) {
      for (const t of g.tables) groupedTableNames.add(t.toLowerCase())
    }

    let metaX = 0
    let metaY = 0
    let metaRowH = 0
    const META_COLS = 3
    let metaColIdx = 0

    for (const group of groups) {
      const groupTableNames = new Set(group.tables.map((t) => t.toLowerCase()))
      const groupTables = tables.filter((t) => groupTableNames.has(t.name.toLowerCase()))
      if (groupTables.length === 0) continue

      // Layout tables in a mini-grid inside the group
      const cols = Math.max(1, Math.ceil(Math.sqrt(groupTables.length)))
      let gx = GROUP_PADDING
      let gy = GROUP_PADDING_TOP
      let colIdx = 0
      let rowH = 0
      let groupMaxW = 0

      for (const t of groupTables) {
        const h = estimateHeight(t.columns.length)
        nodes.push({
          id: t.name,
          type: 'ddlTable',
          position: { x: gx, y: gy },
          data: { label: t.name, columns: t.columns, fks: t.fks } as DdlNodeData,
          parentId: `group-${group.id}`,
          expandParent: true,
        })

        rowH = Math.max(rowH, h)
        colIdx++
        if (colIdx >= cols) {
          groupMaxW = Math.max(groupMaxW, cols * (NODE_W + NODE_GAP_X) - NODE_GAP_X)
          colIdx = 0
          gx = GROUP_PADDING
          gy += rowH + NODE_GAP_Y
          rowH = 0
        } else {
          gx += NODE_W + NODE_GAP_X
        }
      }

      // Account for partial last row
      groupMaxW = Math.max(groupMaxW, colIdx * (NODE_W + NODE_GAP_X) - (colIdx > 0 ? NODE_GAP_X : 0))
      const groupW = groupMaxW + GROUP_PADDING * 2
      const groupH = gy + (rowH > 0 ? rowH + GROUP_PADDING : GROUP_PADDING)

      nodes.push({
        id: `group-${group.id}`,
        type: 'ddlGroup',
        position: { x: metaX, y: metaY },
        data: { label: group.label, color: group.color, groupId: group.id } as DdlGroupNodeData,
        style: { width: groupW, height: groupH },
      })

      metaRowH = Math.max(metaRowH, groupH)
      metaColIdx++
      if (metaColIdx >= META_COLS) {
        metaColIdx = 0
        metaX = 0
        metaY += metaRowH + NODE_GAP_Y * 2
        metaRowH = 0
      } else {
        metaX += groupW + NODE_GAP_X * 2
      }
    }

    // Ungrouped tables in a flat grid below groups
    const ungrouped = tables.filter((t) => !groupedTableNames.has(t.name.toLowerCase()))
    if (ungrouped.length > 0) {
      let ux = 0
      let uy = metaY + metaRowH + NODE_GAP_Y * 2
      const uCols = Math.max(1, Math.ceil(Math.sqrt(ungrouped.length)))
      let uColIdx = 0
      let uRowH = 0

      for (const t of ungrouped) {
        const h = estimateHeight(t.columns.length)
        nodes.push({
          id: t.name,
          type: 'ddlTable',
          position: { x: ux, y: uy },
          data: { label: t.name, columns: t.columns, fks: t.fks } as DdlNodeData,
        })
        uRowH = Math.max(uRowH, h)
        uColIdx++
        if (uColIdx >= uCols) {
          uColIdx = 0
          ux = 0
          uy += uRowH + NODE_GAP_Y
          uRowH = 0
        } else {
          ux += NODE_W + NODE_GAP_X
        }
      }
    }
  }

  // Sort parents before children (ReactFlow requirement)
  const sortedNodes = sortParentsFirst(nodes)

  return { nodes: sortedNodes, edges: [] }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

interface DdlCanvasProps {
  tables: ParsedTable[]
  erdGroups?: ErdGroup[]
  erdLayout?: Record<string, { x: number; y: number }>
  isEditing: boolean
  hiddenTables?: Set<string>
  onLayoutChange?: (layout: Record<string, { x: number; y: number }>) => void
}

function DdlCanvas({ tables, erdGroups, erdLayout, isEditing, hiddenTables, onLayoutChange }: DdlCanvasProps) {
  const { fitView } = useReactFlow()
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  const { nodes: initialNodes, edges } = useMemo(
    () => buildDdlGraph({ tables, erdGroups, erdLayout, hiddenTables }),
    [tables, erdGroups, erdLayout, hiddenTables],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)

  // Re-sync when graph data changes
  useEffect(() => {
    setNodes(initialNodes)
  }, [initialNodes, setNodes])

  const onInit = useCallback(
    (instance: ReactFlowInstance) => {
      reactFlowRef.current = instance
      setTimeout(() => fitView({ padding: 0.15, maxZoom: 1 }), 50)
    },
    [fitView],
  )

  // Save positions on drag stop (edit mode only)
  const onNodeDragStop = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!isEditing || !onLayoutChange || !reactFlowRef.current) return
      if (node.type === 'ddlGroup') return

      const layout: Record<string, { x: number; y: number }> = {}
      for (const n of nodes) {
        if (n.type !== 'ddlTable') continue
        const internal = reactFlowRef.current.getInternalNode(n.id)
        const absPos = internal?.internals.positionAbsolute ?? n.position
        layout[n.id] = { x: Math.round(absPos.x), y: Math.round(absPos.y) }
      }
      onLayoutChange(layout)
    },
    [isEditing, nodes, onLayoutChange],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      onNodesChange={isEditing ? onNodesChange : undefined}
      onNodeDragStop={isEditing ? onNodeDragStop : undefined}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      panOnScroll
      zoomOnScroll
      minZoom={0.1}
      maxZoom={3}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={isEditing}
      nodesConnectable={false}
      elementsSelectable={isEditing}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-muted-foreground)" className="opacity-15" />
      <Controls
        showInteractive={false}
        className="!bg-card !border-border !shadow-sm [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-muted-foreground [&>button:hover]:!bg-muted"
      />
    </ReactFlow>
  )
}

// ---------------------------------------------------------------------------
// Filter panel (visible outside edit mode)
// ---------------------------------------------------------------------------

const COLOR_DOT_ERD: Record<string, string> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  orange: 'bg-orange-500',
  purple: 'bg-purple-500',
  teal: 'bg-teal-500',
  red: 'bg-red-500',
  slate: 'bg-slate-500',
}

interface ErdFilterSheetProps {
  groups: ErdGroup[]
  allTables: ParsedTable[]
  hiddenGroups: Set<string>
  hiddenTables: Set<string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggleGroup: (groupId: string) => void
  onToggleTable: (tableName: string) => void
}

function ErdFilterSheet({ groups, allTables, hiddenGroups, hiddenTables, open, onOpenChange, onToggleGroup, onToggleTable }: ErdFilterSheetProps) {
  const { t } = useTranslation()
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)

  const groupedTableNames = useMemo(() => {
    const set = new Set<string>()
    for (const g of groups) for (const tbl of g.tables) set.add(tbl.toLowerCase())
    return set
  }, [groups])
  const ungrouped = allTables.filter((tbl) => !groupedTableNames.has(tbl.name.toLowerCase()))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[280px] sm:max-w-[280px] p-0 gap-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="text-sm">{t('schemas.erd_filter')}</SheetTitle>
          <SheetDescription className="sr-only">{t('schemas.erd_filter')}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto p-3 space-y-1">
          {groups.map((group) => {
            const groupHidden = hiddenGroups.has(group.id)
            const isExpanded = expandedGroupId === group.id
            const groupTables = allTables.filter((tbl) => group.tables.some((gt) => gt.toLowerCase() === tbl.name.toLowerCase()))

            return (
              <div key={group.id}>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="p-0.5 hover:bg-muted/50 rounded"
                    onClick={() => setExpandedGroupId(isExpanded ? null : group.id)}
                  >
                    {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </button>
                  <label className="flex items-center gap-2 flex-1 cursor-pointer py-0.5">
                    <input
                      type="checkbox"
                      checked={!groupHidden}
                      onChange={() => onToggleGroup(group.id)}
                      className="rounded"
                    />
                    <span className={`w-2 h-2 rounded-full shrink-0 ${COLOR_DOT_ERD[group.color] ?? COLOR_DOT_ERD.slate}`} />
                    <span className="text-xs text-foreground truncate">{group.label}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{groupTables.length}</span>
                  </label>
                </div>
                {isExpanded && (
                  <div className="ml-6 space-y-px">
                    {groupTables.map((tbl) => {
                      const hidden = hiddenTables.has(tbl.name.toLowerCase())
                      return (
                        <label key={tbl.name} className="flex items-center gap-2 px-1 py-0.5 rounded text-xs cursor-pointer hover:bg-muted/50">
                          <input
                            type="checkbox"
                            checked={!hidden && !groupHidden}
                            disabled={groupHidden}
                            onChange={() => onToggleTable(tbl.name.toLowerCase())}
                            className="rounded"
                          />
                          <code className="text-[10px] font-mono text-foreground/80">{tbl.name}</code>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {ungrouped.length > 0 && (
            <div className="pt-1 border-t mt-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase px-1">{t('schemas.erd_ungrouped')}</span>
              <div className="mt-1 space-y-px">
                {ungrouped.map((tbl) => {
                  const hidden = hiddenTables.has(tbl.name.toLowerCase())
                  return (
                    <label key={tbl.name} className="flex items-center gap-2 px-1 py-0.5 rounded text-xs cursor-pointer hover:bg-muted/50">
                      <input
                        type="checkbox"
                        checked={!hidden}
                        onChange={() => onToggleTable(tbl.name.toLowerCase())}
                        className="rounded"
                      />
                      <code className="text-[10px] font-mono text-foreground/80">{tbl.name}</code>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface DdlERDProps {
  ddl: string
  erdGroups?: ErdGroup[]
  erdLayout?: Record<string, { x: number; y: number }>
  editable?: boolean
  onLayoutChange?: (layout: Record<string, { x: number; y: number }>) => void
  onGroupsChange?: (groups: ErdGroup[]) => void
}

export function DdlERD({
  ddl,
  erdGroups,
  erdLayout,
  editable,
  onLayoutChange,
  onGroupsChange,
}: DdlERDProps) {
  const { t } = useTranslation()
  const tables = useMemo(() => parseDdl(ddl), [ddl])
  const [isEditing, setIsEditing] = useState(false)
  const [groupPanelOpen, setGroupPanelOpen] = useState(false)
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const [hiddenTableNames, setHiddenTableNames] = useState<Set<string>>(new Set())

  // Compute effective hidden tables (hidden groups + individually hidden tables)
  const hiddenTables = useMemo(() => {
    const set = new Set(hiddenTableNames)
    for (const group of erdGroups ?? []) {
      if (hiddenGroups.has(group.id)) {
        for (const t of group.tables) set.add(t.toLowerCase())
      }
    }
    return set.size > 0 ? set : undefined
  }, [hiddenGroups, hiddenTableNames, erdGroups])

  const toggleGroup = useCallback((groupId: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const toggleTable = useCallback((tableName: string) => {
    setHiddenTableNames((prev) => {
      const next = new Set(prev)
      if (next.has(tableName)) next.delete(tableName)
      else next.add(tableName)
      return next
    })
  }, [])

  if (tables.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        {t('schemas.erd_no_tables')}
      </div>
    )
  }

  return (
    <div className="w-full h-full relative">
      {/* Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
        {/* Filter toggle (visible when groups exist, outside edit mode) */}
        {!isEditing && (erdGroups ?? []).length > 0 && (
          <Button
            variant={filterPanelOpen ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterPanelOpen((v) => !v)}
            className="gap-1.5 text-xs"
          >
            <Filter size={13} />
            {t('schemas.erd_filter')}
          </Button>
        )}
        {/* Edit mode buttons */}
        {editable && isEditing && erdLayout && Object.keys(erdLayout).length > 0 && onLayoutChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onLayoutChange({})}
            className="gap-1.5 text-xs"
          >
            <RotateCcw size={13} />
            {t('schemas.erd_reset_layout')}
          </Button>
        )}
        {editable && isEditing && onGroupsChange && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setGroupPanelOpen((v) => !v)}
            className="gap-1.5 text-xs"
          >
            <Palette size={13} />
            {t('schemas.erd_groups')}
          </Button>
        )}
        {editable && (
          <Button
            variant={isEditing ? 'default' : 'outline'}
            size="sm"
            onClick={() => {
              setIsEditing((v) => !v)
              if (isEditing) {
                setGroupPanelOpen(false)
              } else {
                setFilterPanelOpen(false)
              }
            }}
            className="gap-1.5 text-xs"
          >
            {isEditing ? <Check size={13} /> : <Pencil size={13} />}
            {isEditing ? t('schemas.erd_done') : t('schemas.erd_edit_layout')}
          </Button>
        )}
      </div>

      <div className="flex h-full">
        <div className="flex-1 h-full">
          <ReactFlowProvider>
            <DdlCanvas
              tables={tables}
              erdGroups={erdGroups}
              erdLayout={erdLayout}
              isEditing={isEditing}
              hiddenTables={hiddenTables}
              onLayoutChange={onLayoutChange}
            />
          </ReactFlowProvider>
        </div>

        {/* Filter sheet (portal-based, full viewport height) */}
        <ErdFilterSheet
          groups={erdGroups ?? []}
          allTables={tables}
          hiddenGroups={hiddenGroups}
          hiddenTables={hiddenTableNames}
          open={filterPanelOpen && !isEditing}
          onOpenChange={setFilterPanelOpen}
          onToggleGroup={toggleGroup}
          onToggleTable={toggleTable}
        />

        {/* Group editing side panel (edit mode) */}
        {groupPanelOpen && isEditing && onGroupsChange && (
          <DdlERDGroupPanel
            groups={erdGroups ?? []}
            allTables={tables.map((t) => t.name)}
            onChange={onGroupsChange}
            onClose={() => setGroupPanelOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
