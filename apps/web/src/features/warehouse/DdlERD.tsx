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
import { Table2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedColumn {
  name: string
  type: string
  nullable: boolean
  isPk: boolean
}

interface ParsedTable {
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

// ---------------------------------------------------------------------------
// DDL Parser
// ---------------------------------------------------------------------------

function parseDdl(ddl: string): ParsedTable[] {
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
// Custom node: DDL table card
// ---------------------------------------------------------------------------

const ROLE_BADGES: Record<string, string> = {
  pk: 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200',
  fk: 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200',
}

function DdlTableNode({ data }: NodeProps<Node<DdlNodeData>>) {
  // Collect FK column names for badge display
  const fkColumnSet = useMemo(() => {
    const set = new Set<string>()
    for (const fk of data.fks ?? []) {
      for (const col of fk.columns) set.add(col)
    }
    return set
  }, [data.fks])

  return (
    <div
      className="rounded-lg border-2 shadow-lg bg-card border-border"
      style={{ width: 260 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 rounded-t-md px-3 py-2 bg-muted/60" title={data.label}>
        <Table2 size={13} className="text-muted-foreground shrink-0" />
        <span className="text-xs font-bold text-foreground truncate">{data.label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{data.columns.length}</span>
      </div>
      {/* Columns */}
      <div className="px-2 py-1.5 space-y-px">
        {data.columns.map((col) => {
          const isPk = col.isPk
          const isFk = fkColumnSet.has(col.name)
          return (
            <div key={col.name} className="flex items-center gap-1 relative py-px" title={`${col.name} ${col.type}${col.nullable ? '' : ' NOT NULL'}`}>
              {isPk || isFk ? (
                <span className={`inline-flex items-center justify-center rounded min-w-[22px] px-0.5 text-center text-[7px] font-bold uppercase leading-none py-0.5 ${isPk ? ROLE_BADGES.pk : ROLE_BADGES.fk}`}>
                  {isPk ? 'PK' : 'FK'}
                </span>
              ) : (
                <span className="min-w-[22px]" />
              )}
              <code className="text-[10px] text-foreground/80 font-mono truncate flex-1">{col.name}</code>
              <span className="text-[9px] text-muted-foreground/60 font-mono shrink-0">{col.type.toLowerCase()}</span>
              {/* Handles for FK edges */}
              {isPk && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`pk-${col.name}`}
                  className="!w-1.5 !h-1.5 !bg-yellow-500 !border-[1px] !border-background !left-[-9px]"
                />
              )}
              {isFk && (
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`fk-${col.name}`}
                  className="!w-1.5 !h-1.5 !bg-blue-500 !border-[1px] !border-background !right-[-9px]"
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const nodeTypes = { ddlTable: DdlTableNode }

// ---------------------------------------------------------------------------
// Build graph with grid layout
// ---------------------------------------------------------------------------

function buildDdlGraph(tables: ParsedTable[]): { nodes: Node<DdlNodeData>[]; edges: Edge[] } {
  const nodes: Node<DdlNodeData>[] = []
  const edges: Edge[] = []

  const NODE_W = 290
  const NODE_GAP_X = 30
  const NODE_GAP_Y = 30

  // Estimate node height
  const estimateHeight = (colCount: number) => 36 + colCount * 18 + 12

  // Grid layout: arrange in columns
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)))
  let x = 0
  let y = 0
  let colIndex = 0
  let maxHeightInRow = 0

  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]
    const h = estimateHeight(t.columns.length)

    nodes.push({
      id: t.name,
      type: 'ddlTable',
      position: { x, y },
      data: { label: t.name, columns: t.columns, fks: t.fks },
    })

    maxHeightInRow = Math.max(maxHeightInRow, h)
    colIndex++

    if (colIndex >= cols) {
      colIndex = 0
      x = 0
      y += maxHeightInRow + NODE_GAP_Y
      maxHeightInRow = 0
    } else {
      x += NODE_W + NODE_GAP_X
    }
  }

  // Build a case-insensitive lookup: lowercase name → actual node id
  const tableNameToId = new Map<string, string>()
  for (const t of tables) tableNameToId.set(t.name.toLowerCase(), t.name)

  // Build FK edges
  for (const t of tables) {
    for (const fk of t.fks) {
      const targetId = tableNameToId.get(fk.refTable.toLowerCase())
      if (!targetId) continue
      for (let i = 0; i < fk.columns.length; i++) {
        const srcCol = fk.columns[i]
        const tgtCol = fk.refColumns[i]
        if (srcCol && tgtCol) {
          edges.push({
            id: `fk-${t.name}-${srcCol}-${targetId}-${tgtCol}`,
            source: t.name,
            sourceHandle: `fk-${srcCol}`,
            target: targetId,
            targetHandle: `pk-${tgtCol}`,
            type: 'smoothstep',
            animated: true,
            style: { stroke: '#3b82f6', strokeWidth: 1.5 },
          })
        }
      }
    }
  }

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

function DdlCanvas({ tables }: { tables: ParsedTable[] }) {
  const { fitView } = useReactFlow()
  const { nodes, edges } = useMemo(() => buildDdlGraph(tables), [tables])

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.15, maxZoom: 1 }), 50)
  }, [fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={onInit}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      panOnScroll
      zoomOnScroll
      minZoom={0.1}
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

export function DdlERD({ ddl }: { ddl: string }) {
  const tables = useMemo(() => parseDdl(ddl), [ddl])

  if (tables.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No tables found in DDL
      </div>
    )
  }

  return (
    <div className="w-full h-full">
      <ReactFlowProvider>
        <DdlCanvas tables={tables} />
      </ReactFlowProvider>
    </div>
  )
}
