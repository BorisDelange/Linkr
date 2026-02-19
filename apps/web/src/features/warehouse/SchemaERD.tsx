import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  type Edge,
  type NodeProps,
  Handle,
  Position,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Table2, User, Stethoscope, BookOpen, Activity } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { SchemaMapping, ConceptDictionary, EventTable } from '@/types/schema-mapping'

// ---------------------------------------------------------------------------
// Custom node: ERD table card with per-column handles + tooltips
// ---------------------------------------------------------------------------

interface ColumnDef {
  name: string
  role?: 'pk' | 'fk' | 'value' | 'date'
  /** Unique handle ID for edges to connect to specific columns */
  handleId?: string
  /** Whether this column is a target (incoming FK) or source (outgoing FK) */
  handleType?: 'source' | 'target'
  /** FK target description for tooltip */
  fkTarget?: string
}

interface ERDNodeData {
  [key: string]: unknown
  label: string
  tableType: 'patient' | 'visit' | 'concept' | 'event'
  columns: ColumnDef[]
}

const COLORS: Record<string, { bg: string; border: string; headerBg: string; icon: string }> = {
  patient: { bg: 'bg-blue-50 dark:bg-blue-950', border: 'border-blue-400 dark:border-blue-600', headerBg: 'bg-blue-100 dark:bg-blue-900', icon: 'text-blue-600 dark:text-blue-400' },
  visit: { bg: 'bg-teal-50 dark:bg-teal-950', border: 'border-teal-400 dark:border-teal-600', headerBg: 'bg-teal-100 dark:bg-teal-900', icon: 'text-teal-600 dark:text-teal-400' },
  concept: { bg: 'bg-amber-50 dark:bg-amber-950', border: 'border-amber-400 dark:border-amber-600', headerBg: 'bg-amber-100 dark:bg-amber-900', icon: 'text-amber-600 dark:text-amber-400' },
  event: { bg: 'bg-rose-50 dark:bg-rose-950', border: 'border-rose-400 dark:border-rose-600', headerBg: 'bg-rose-100 dark:bg-rose-900', icon: 'text-rose-600 dark:text-rose-400' },
}

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  patient: User,
  visit: Stethoscope,
  concept: BookOpen,
  event: Activity,
}

const ROLE_BADGES: Record<string, string> = {
  pk: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200',
  fk: 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200',
  value: 'bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200',
  date: 'bg-violet-200 text-violet-800 dark:bg-violet-800 dark:text-violet-200',
}

function ERDTableNode({ data }: NodeProps<Node<ERDNodeData>>) {
  const colors = COLORS[data.tableType] ?? COLORS.event
  const Icon = ICONS[data.tableType] ?? Table2

  return (
    <TooltipProvider>
      <div
        className={`rounded-lg border-2 shadow-lg ${colors.bg} ${colors.border}`}
        style={{ width: 220 }}
      >
        {/* Header */}
        <div className={`flex items-center gap-2 rounded-t-md px-3 py-2 ${colors.headerBg}`}>
          <Icon size={14} className={`${colors.icon} shrink-0`} />
          <span className="text-xs font-bold text-foreground truncate">{data.label}</span>
        </div>
        {/* Columns */}
        <div className="px-3 py-2 space-y-0.5">
          {data.columns.map((col) => {
            const hasHandle = !!col.handleId
            const row = (
              <div className="flex items-center gap-1.5 relative">
                {col.role ? (
                  <span className={`inline-flex items-center justify-center rounded min-w-[28px] px-1 text-center text-[8px] font-bold uppercase leading-none py-0.5 ${ROLE_BADGES[col.role]}`}>
                    {col.role}
                  </span>
                ) : (
                  <span className="min-w-[28px]" />
                )}
                <code className="text-[11px] text-foreground/80 font-mono truncate">{col.name}</code>
                {col.handleId && col.handleType === 'source' && (
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={col.handleId}
                    className="!w-2 !h-2 !bg-muted-foreground/40 !border-[1.5px] !border-background !right-[-13px]"
                  />
                )}
                {col.handleId && col.handleType === 'target' && (
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={col.handleId}
                    className="!w-2 !h-2 !bg-muted-foreground/40 !border-[1.5px] !border-background !left-[-13px]"
                  />
                )}
              </div>
            )

            if (!hasHandle) return <div key={col.name}>{row}</div>

            return (
              <Tooltip key={col.name}>
                <TooltipTrigger asChild>{row}</TooltipTrigger>
                <TooltipContent side={col.handleType === 'source' ? 'right' : 'left'} sideOffset={12}>
                  <div className="space-y-0.5">
                    <div className="font-mono font-semibold">{col.name}</div>
                    {col.role === 'pk' && <div className="text-[10px] opacity-80">Primary Key</div>}
                    {col.role === 'fk' && col.fkTarget && <div className="text-[10px] opacity-80">FK &rarr; {col.fkTarget}</div>}
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

const nodeTypes = { erdTable: ERDTableNode }

// ---------------------------------------------------------------------------
// Build graph from SchemaMapping — nodes with handle dots + FK edges
// ---------------------------------------------------------------------------

function buildERDGraph(mapping: SchemaMapping): { nodes: Node<ERDNodeData>[]; edges: Edge[] } {
  const nodes: Node<ERDNodeData>[] = []
  const edges: Edge[] = []

  const NODE_W = 280
  const ROW_GAP = 40

  const conceptCount = mapping.conceptTables?.length ?? 0
  const eventCount = mapping.eventTables ? Object.keys(mapping.eventTables).length : 0
  const maxCols = Math.max(2, conceptCount, eventCount)

  const centerX = (n: number) => ((maxCols - n) / 2) * NODE_W
  const estimateHeight = (colCount: number) => 32 + colCount * 20 + 16

  let row0MaxHeight = 0

  // Row 0: Patient + Visit
  const row0Count = (mapping.patientTable ? 1 : 0) + (mapping.visitTable ? 1 : 0)
  let col0 = centerX(row0Count)

  if (mapping.patientTable) {
    const pt = mapping.patientTable
    const columns: ColumnDef[] = [
      { name: pt.idColumn, role: 'pk', handleId: 'pk', handleType: 'target' },
    ]
    if (pt.birthDateColumn) columns.push({ name: pt.birthDateColumn, role: 'date' })
    if (pt.birthYearColumn) columns.push({ name: pt.birthYearColumn })
    if (pt.genderColumn) columns.push({ name: pt.genderColumn })

    nodes.push({
      id: `patient-${pt.table}`,
      type: 'erdTable',
      position: { x: col0, y: 0 },
      zIndex: 1,
      data: { label: pt.table, tableType: 'patient', columns },
    })
    row0MaxHeight = Math.max(row0MaxHeight, estimateHeight(columns.length))
    col0 += NODE_W
  }

  if (mapping.visitTable) {
    const vt = mapping.visitTable
    const columns: ColumnDef[] = [
      { name: vt.idColumn, role: 'pk', handleId: 'pk', handleType: 'target' },
      { name: vt.patientIdColumn, role: 'fk', handleId: 'fk-patient', handleType: 'source', fkTarget: `${mapping.patientTable?.table ?? '?'}.${mapping.patientTable?.idColumn ?? '?'}` },
      { name: vt.startDateColumn, role: 'date' },
    ]
    if (vt.endDateColumn) columns.push({ name: vt.endDateColumn, role: 'date' })

    nodes.push({
      id: `visit-${vt.table}`,
      type: 'erdTable',
      position: { x: col0, y: 0 },
      zIndex: 1,
      data: { label: vt.table, tableType: 'visit', columns },
    })
    row0MaxHeight = Math.max(row0MaxHeight, estimateHeight(columns.length))
  }

  // Row 1: Concept dictionaries
  const row1Y = row0MaxHeight + ROW_GAP
  let row1MaxHeight = 0

  if (mapping.conceptTables && conceptCount > 0) {
    const startX = centerX(conceptCount)
    mapping.conceptTables.forEach((dict: ConceptDictionary, i: number) => {
      const columns: ColumnDef[] = [
        { name: dict.idColumn, role: 'pk', handleId: 'pk', handleType: 'target' },
        { name: dict.nameColumn },
      ]
      if (dict.codeColumn) columns.push({ name: dict.codeColumn })
      if (dict.vocabularyColumn) columns.push({ name: dict.vocabularyColumn })
      if (dict.extraColumns) {
        Object.values(dict.extraColumns).forEach((col) => columns.push({ name: col }))
      }

      nodes.push({
        id: `concept-${dict.key}`,
        type: 'erdTable',
        position: { x: startX + i * NODE_W, y: row1Y },
        zIndex: 1,
        data: { label: dict.table, tableType: 'concept', columns },
      })
      row1MaxHeight = Math.max(row1MaxHeight, estimateHeight(columns.length))
    })
  }

  // Row 2: Event tables
  const row2Y = row1Y + (row1MaxHeight > 0 ? row1MaxHeight + ROW_GAP : 0)

  if (mapping.eventTables && eventCount > 0) {
    const startX = centerX(eventCount)
    const eventEntries = Object.entries(mapping.eventTables)
    eventEntries.forEach(([label, et]: [string, EventTable], i: number) => {
      // Resolve FK targets for tooltips
      const dictKey = et.conceptDictionaryKey ?? mapping.conceptTables?.[0]?.key
      const dictTable = mapping.conceptTables?.find((d) => d.key === dictKey)
      const conceptFkTarget = dictTable ? `${dictTable.table}.${dictTable.idColumn}` : undefined
      const patientFkTarget = mapping.patientTable ? `${mapping.patientTable.table}.${mapping.patientTable.idColumn}` : undefined

      const columns: ColumnDef[] = [
        { name: et.conceptIdColumn, role: 'fk', handleId: 'fk-concept', handleType: 'source', fkTarget: conceptFkTarget },
      ]
      if (et.sourceConceptIdColumn) columns.push({ name: et.sourceConceptIdColumn, role: 'fk' })
      if (et.patientIdColumn) columns.push({ name: et.patientIdColumn, role: 'fk', handleId: 'fk-patient', handleType: 'source', fkTarget: patientFkTarget })
      if (et.valueColumn) columns.push({ name: et.valueColumn, role: 'value' })
      if (et.valueStringColumn) columns.push({ name: et.valueStringColumn, role: 'value' })
      if (et.dateColumn) columns.push({ name: et.dateColumn, role: 'date' })

      nodes.push({
        id: `event-${label}`,
        type: 'erdTable',
        position: { x: startX + i * NODE_W, y: row2Y },
        zIndex: 1,
        data: { label: `${et.table} (${label})`, tableType: 'event', columns },
      })
    })
  }

  // Build edges from FK handles
  // Visit → Patient
  if (mapping.visitTable && mapping.patientTable) {
    edges.push({
      id: 'e-visit-patient',
      source: `visit-${mapping.visitTable.table}`,
      sourceHandle: 'fk-patient',
      target: `patient-${mapping.patientTable.table}`,
      targetHandle: 'pk',
      type: 'smoothstep',
      style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.35 },
    })
  }

  // Event tables → Concept dictionary + Patient
  if (mapping.eventTables) {
    const eventEntries = Object.entries(mapping.eventTables)
    eventEntries.forEach(([label, et]: [string, EventTable]) => {
      // Event → Concept dictionary
      const dictKey = et.conceptDictionaryKey ?? mapping.conceptTables?.[0]?.key
      if (dictKey) {
        edges.push({
          id: `e-${label}-concept`,
          source: `event-${label}`,
          sourceHandle: 'fk-concept',
          target: `concept-${dictKey}`,
          targetHandle: 'pk',
          type: 'smoothstep',
          style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.35 },
        })
      }
      // Event → Patient
      if (et.patientIdColumn && mapping.patientTable) {
        edges.push({
          id: `e-${label}-patient`,
          source: `event-${label}`,
          sourceHandle: 'fk-patient',
          target: `patient-${mapping.patientTable.table}`,
          targetHandle: 'pk',
          type: 'smoothstep',
          style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5, opacity: 0.35 },
        })
      }
    })
  }

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Shared ReactFlow canvas
// ---------------------------------------------------------------------------

function ERDCanvas({ mapping }: { mapping: SchemaMapping }) {
  const { fitView } = useReactFlow()

  const { nodes, edges } = useMemo(() => buildERDGraph(mapping), [mapping])

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2, maxZoom: 1 }), 50)
  }, [fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      panOnScroll
      zoomOnScroll
      minZoom={0.2}
      maxZoom={3}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
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
// Public component
// ---------------------------------------------------------------------------

export function SchemaERD({
  mapping,
  fullscreen,
}: {
  mapping: SchemaMapping
  /** When true, fills its parent container */
  fullscreen?: boolean
}) {
  const hasContent =
    mapping.patientTable ||
    mapping.visitTable ||
    (mapping.conceptTables && mapping.conceptTables.length > 0) ||
    (mapping.eventTables && Object.keys(mapping.eventTables).length > 0)

  if (!hasContent) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No tables configured
      </div>
    )
  }

  return (
    <div className={fullscreen ? 'w-full h-full' : 'w-full h-[350px] rounded-lg border bg-background overflow-hidden'}>
      <ReactFlowProvider>
        <ERDCanvas mapping={mapping} />
      </ReactFlowProvider>
    </div>
  )
}
