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
import { Table2, User, Stethoscope, BookOpen, Activity, Pill } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import type { RelationSpec, SchemaMapping } from '@/types/schema-mapping'
import { fieldRef } from '@/lib/schema-classes/spec'
import type { ClassName } from '@/lib/schema-classes/contracts'
import { CLASS_TONES } from './schema-mapping/class-tones'
import { ErdHighlightProvider, useErdHighlight, useErdHighlightState, useHandleHover } from './erd-highlight'

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
  tableType: ClassName
  columns: ColumnDef[]
}

const ICONS: Partial<Record<ClassName, React.ComponentType<{ size?: number; className?: string }>>> = {
  patient: User,
  visit: Stethoscope,
  concept: BookOpen,
  event: Activity,
  drug: Pill,
}

const ROLE_BADGES: Record<string, string> = {
  pk: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200',
  fk: 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200',
  value: 'bg-emerald-200 text-emerald-800 dark:bg-emerald-800 dark:text-emerald-200',
  date: 'bg-violet-200 text-violet-800 dark:bg-violet-800 dark:text-violet-200',
}

function ERDTableNode({ id, data }: NodeProps<Node<ERDNodeData>>) {
  const { selected } = useErdHighlight()
  const colors = CLASS_TONES[data.tableType].node
  const Icon = ICONS[data.tableType] ?? Table2

  return (
    <TooltipProvider>
      <div
        className={`rounded-lg border-2 shadow-lg ${colors.bg} ${selected === id ? 'border-primary' : colors.border}`}
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
                {col.handleId && col.handleType && <HoverHandle node={id} id={col.handleId} type={col.handleType} />}
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

/** A connection point that lights up its links on hover (see DdlERD's HoverHandle). */
function HoverHandle({ node, id, type }: { node: string; id: string; type: 'source' | 'target' }) {
  const hover = useHandleHover(node, id)
  return (
    <Handle
      type={type}
      position={type === 'target' ? Position.Left : Position.Right}
      id={id}
      {...hover}
      className={`!w-2 !h-2 !bg-muted-foreground/40 !border-[1.5px] !border-background hover:!bg-primary !pointer-events-auto after:absolute after:-inset-1.5 after:content-[''] hover:!shadow-[0_0_0_3px_var(--color-primary)] ${type === 'target' ? '!left-[-13px]' : '!right-[-13px]'}`}
    />
  )
}

const nodeTypes = { erdTable: ERDTableNode }

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const PK_FIELD: Record<string, string> = { patient: 'patient_id', visit: 'visit_id', concept: 'concept_id' }

/** A relation's mapped fields as ERD rows: the source column a reference reads,
 *  or the contract column marked ƒx for an expression. */
function relationColumns(cls: string, spec: RelationSpec, fkTargets: Record<string, string | undefined>): ColumnDef[] {
  if (spec.customSql?.trim()) return [{ name: 'SQL' }]
  return Object.entries(spec.fields ?? {}).map(([field, f]) => {
    const ref = fieldRef(f)
    const name = ref ? ref.column : `${field} (ƒx)`
    if (PK_FIELD[cls] === field) return { name, role: 'pk', handleId: 'pk', handleType: 'target' }
    if (field === 'patient_id' || field === 'concept_id') {
      return { name, role: 'fk', handleId: `fk-${field === 'patient_id' ? 'patient' : 'concept'}`, handleType: 'source', fkTarget: fkTargets[field] }
    }
    if (field === 'visit_id' || field === 'source_concept_id') return { name, role: 'fk' }
    if (field.startsWith('value_')) return { name, role: 'value' }
    if (/datetime$|_date$/.test(field)) return { name, role: 'date' }
    return { name }
  })
}

const relationLabel = (spec: RelationSpec, fallback: string) => spec.from?.table ?? fallback

function buildERDGraph(mapping: SchemaMapping): { nodes: Node<ERDNodeData>[]; edges: Edge[] } {
  const nodes: Node<ERDNodeData>[] = []
  const edges: Edge[] = []

  const NODE_W = 280
  const ROW_GAP = 40

  const concepts = mapping.concepts ?? []
  const events = [...(mapping.events ?? []), ...(mapping.drugs ?? [])]
  const maxCols = Math.max(2, concepts.length, events.length)

  const centerX = (n: number) => ((maxCols - n) / 2) * NODE_W
  const estimateHeight = (colCount: number) => 32 + colCount * 20 + 16

  const patientRef = mapping.patient ? fieldRef(mapping.patient.fields?.patient_id) : null
  const patientTarget = mapping.patient ? `${relationLabel(mapping.patient, 'patient')}.${patientRef?.column ?? 'patient_id'}` : undefined

  // Row 0: Patient + Visit
  let row0MaxHeight = 0
  const row0 = [
    mapping.patient ? { id: 'patient', cls: 'patient', spec: mapping.patient } : null,
    mapping.visit ? { id: 'visit', cls: 'visit', spec: mapping.visit } : null,
  ].filter((x): x is { id: string; cls: string; spec: RelationSpec } => !!x)
  let col0 = centerX(row0.length)
  for (const { id, cls, spec } of row0) {
    const columns = relationColumns(cls, spec, { patient_id: patientTarget })
    nodes.push({
      id,
      type: 'erdTable',
      position: { x: col0, y: 0 },
      zIndex: 1,
      data: { label: relationLabel(spec, id), tableType: cls as ERDNodeData['tableType'], columns },
    })
    row0MaxHeight = Math.max(row0MaxHeight, estimateHeight(columns.length))
    col0 += NODE_W
  }

  // Row 1: Concept dictionaries
  const row1Y = row0MaxHeight + ROW_GAP
  let row1MaxHeight = 0
  const startX1 = centerX(concepts.length)
  concepts.forEach((dict, i) => {
    const columns = relationColumns('concept', dict, {})
    nodes.push({
      id: `concept-${dict.key}`,
      type: 'erdTable',
      position: { x: startX1 + i * NODE_W, y: row1Y },
      zIndex: 1,
      data: { label: relationLabel(dict, dict.key), tableType: 'concept', columns },
    })
    row1MaxHeight = Math.max(row1MaxHeight, estimateHeight(columns.length))
  })

  // Row 2: Event and drug relations
  const row2Y = row1Y + (row1MaxHeight > 0 ? row1MaxHeight + ROW_GAP : 0)
  const startX2 = centerX(events.length)
  events.forEach((ev, i) => {
    const dictKey = ev.conceptDictionaryKey === 'none' ? undefined : (ev.conceptDictionaryKey ?? concepts[0]?.key)
    const dict = concepts.find((d) => d.key === dictKey)
    const conceptTarget = dict ? `${relationLabel(dict, dict.key)}.${fieldRef(dict.fields?.concept_id)?.column ?? 'concept_id'}` : undefined
    const id = `event-${i}`
    nodes.push({
      id,
      type: 'erdTable',
      position: { x: startX2 + i * NODE_W, y: row2Y },
      zIndex: 1,
      data: {
        label: ev.from ? `${ev.from.table} (${ev.label})` : ev.label,
        tableType: i < (mapping.events?.length ?? 0) ? 'event' : 'drug',
        columns: relationColumns(i < (mapping.events?.length ?? 0) ? 'event' : 'drug', ev, { patient_id: patientTarget, concept_id: conceptTarget }),
      },
    })
    if (dict) {
      edges.push({ id: `e-${id}-concept`, source: id, sourceHandle: 'fk-concept', target: `concept-${dict.key}`, targetHandle: 'pk', type: 'smoothstep' })
    }
    if (mapping.patient && ev.fields?.patient_id && !ev.customSql?.trim()) {
      edges.push({ id: `e-${id}-patient`, source: id, sourceHandle: 'fk-patient', target: 'patient', targetHandle: 'pk', type: 'smoothstep' })
    }
  })

  // Visit → Patient
  if (mapping.visit?.fields?.patient_id && mapping.patient && !mapping.visit.customSql?.trim()) {
    edges.push({ id: 'e-visit-patient', source: 'visit', sourceHandle: 'fk-patient', target: 'patient', targetHandle: 'pk', type: 'smoothstep' })
  }

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Shared ReactFlow canvas
// ---------------------------------------------------------------------------

function ERDCanvas({ mapping }: { mapping: SchemaMapping }) {
  const { fitView } = useReactFlow()

  const { nodes, edges } = useMemo(() => buildERDGraph(mapping), [mapping])
  // A handful of links: all drawn, the clicked table's and the hovered point's lit.
  const highlight = useErdHighlightState(edges, true)

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2, maxZoom: 1 }), 50)
  }, [fitView])

  return (
    <ErdHighlightProvider value={highlight.context}>
    <ReactFlow
      nodes={nodes}
      edges={highlight.shown}
      nodeTypes={nodeTypes}
      onInit={onInit}
      onNodeClick={(_, node) => highlight.toggle(node.id)}
      onPaneClick={highlight.clear}
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
    </ErdHighlightProvider>
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
    mapping.patient ||
    mapping.visit ||
    (mapping.concepts?.length ?? 0) > 0 ||
    (mapping.events?.length ?? 0) > 0 ||
    (mapping.drugs?.length ?? 0) > 0

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
