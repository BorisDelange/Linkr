/**
 * The Schemas page ERD (`features/warehouse/SchemaERD.tsx`) as a static SVG,
 * for the standalone catalog page where ReactFlow is not available. Same rows
 * (patient + visit, concept dictionaries, event tables), same per-type colours
 * and role badges, edges drawn from the FK column to the PK it references.
 * Colours come from CSS classes so the page's dark mode applies.
 */
import type { SchemaMapping } from '@/types'
import { escapeXml as esc } from '@/lib/cohort-report/charts'
import { CLASS_CONTRACTS, type ClassName } from '@/lib/schema-classes/contracts'
import { conceptRelations, eventRelation } from '@/lib/schema-classes/relations'
import { fieldRef, specEntries, specTables } from '@/lib/schema-classes/spec'
import { svgIcon, type IconName } from './export-html-style'

export type TableType = 'patient' | 'visit' | 'concept' | 'event'
export type ColumnRole = 'pk' | 'fk' | 'value' | 'date'

export const TABLE_TYPE_ICON: Record<TableType, IconName> = {
  patient: 'user',
  visit: 'stethoscope',
  concept: 'bookOpen',
  event: 'activity',
}

interface ErdColumn {
  name: string
  role?: ColumnRole
  fkTarget?: string
}

interface ErdNode {
  id: string
  table: string
  label: string
  type: TableType
  columns: ErdColumn[]
  x: number
  y: number
}

interface ErdEdge {
  from: string
  fromCol: string
  to: string
  toCol: string
}

const NODE_W = 220
const COL_GAP = 60
const ROW_GAP = 64
const HEADER_H = 30
const ROW_H = 18
const PAD_Y = 8
const MARGIN_X = 48
const MARGIN_Y = 16
// Wider rows would force the diagram below legible size in a 1200px page.
const MAX_PER_ROW = 4

const nodeHeight = (n: ErdNode) => HEADER_H + PAD_Y * 2 + n.columns.length * ROW_H

/** Contract column → the role badge the ERD and the column list give its source column. */
const PK_FIELD: Partial<Record<ClassName, string>> = {
  patient: 'patient_id', visit: 'visit_id', visit_detail: 'visit_detail_id', concept: 'concept_id',
}
const FK_FIELDS = new Set(['patient_id', 'visit_id', 'concept_id', 'source_concept_id'])
const VALUE_FIELDS = new Set(['value_number', 'value_string'])

const TYPE_OF: Partial<Record<ClassName, TableType>> = {
  patient: 'patient', visit: 'visit', visit_detail: 'visit', concept: 'concept', event: 'event', drug: 'event',
}

interface MappedTable {
  id: string
  cls: ClassName
  key?: string
  table: string
  type: TableType
  /** Contract field → source column, for the fields read straight from the grain table. */
  fields: Map<string, string>
}

/** The grain table of each visual relation, with the columns its fields read as is. */
function mappedTables(mapping: SchemaMapping): MappedTable[] {
  const out: MappedTable[] = []
  for (const { cls, spec, key } of specEntries(mapping)) {
    const type = TYPE_OF[cls]
    const grain = specTables(spec)[0]
    if (!type || !grain) continue
    const fields = new Map<string, string>()
    for (const [field, f] of Object.entries(spec.fields ?? {})) {
      const ref = fieldRef(f)
      if (ref && ref.alias.toLowerCase() === grain.alias.toLowerCase()) fields.set(field, ref.column)
    }
    out.push({ id: `${cls}-${key ?? ''}`, cls, key, table: grain.table, type, fields })
  }
  return out
}

function roleOf(cls: ClassName, field: string): ColumnRole | undefined {
  if (PK_FIELD[cls] === field) return 'pk'
  if (FK_FIELDS.has(field)) return 'fk'
  if (VALUE_FIELDS.has(field)) return 'value'
  const kind = CLASS_CONTRACTS[cls].find((c) => c.name === field)?.kind
  return kind === 'datetime' || kind === 'date' ? 'date' : undefined
}

/** Role of each mapped column, per table: shared by the ERD and the column list. */
export function mappingColumnRoles(mapping: SchemaMapping): Map<string, Map<string, ColumnRole>> {
  const roles = new Map<string, Map<string, ColumnRole>>()
  for (const t of mappedTables(mapping)) {
    if (!roles.has(t.table)) roles.set(t.table, new Map())
    const cols = roles.get(t.table)!
    for (const [field, column] of t.fields) {
      const role = roleOf(t.cls, field)
      if (role && !cols.has(column)) cols.set(column, role)
    }
  }
  return roles
}

/** Display type of each mapped table (visit detail shares the visit colour). */
export function mappingTableTypes(mapping: SchemaMapping): Map<string, TableType> {
  const types = new Map<string, TableType>()
  // Most specific last, so a table playing several roles shows as its main one.
  const order: TableType[] = ['event', 'concept', 'visit', 'patient']
  const tables = mappedTables(mapping).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
  for (const t of tables) types.set(t.table, t.type)
  return types
}

function buildGraph(mapping: SchemaMapping): { nodes: ErdNode[]; edges: ErdEdge[] } {
  const tables = mappedTables(mapping)
  const edges: ErdEdge[] = []
  const pkOf = (t: MappedTable | undefined) => (t ? t.fields.get(PK_FIELD[t.cls] ?? '') : undefined)
  const patient = tables.find((t) => t.cls === 'patient')
  const visit = tables.find((t) => t.cls === 'visit')
  const dictByRelation = new Map(conceptRelations(mapping).map((r) => [r.name, tables.find((t) => t.cls === 'concept' && t.key === r.key)]))

  const toNode = (t: MappedTable, label: string): Omit<ErdNode, 'x' | 'y'> => {
    let target: MappedTable | undefined
    const columns: ErdColumn[] = [...t.fields].map(([field, name]) => {
      const role = roleOf(t.cls, field)
      target = field === 'patient_id' && t.cls !== 'patient' ? patient
        : field === 'visit_id' && t.cls !== 'visit' ? visit
        : field === 'concept_id' && (t.cls === 'event' || t.cls === 'drug') ? dictByRelation.get(eventRelation(mapping, t.key ?? '')?.dictionary ?? '')
        : undefined
      const toCol = pkOf(target)
      if (target && toCol && role === 'fk') edges.push({ from: t.id, fromCol: name, to: target.id, toCol })
      return { name, role, fkTarget: target && toCol ? `${target.table}.${toCol}` : undefined }
    })
    // Keys first, then dates and values, then the rest: the rows edges attach to stay on top.
    const rank = (c: ErdColumn) => ['pk', 'fk', 'date', 'value'].indexOf(c.role ?? '') + 1 || 9
    columns.sort((x, y) => rank(x) - rank(y))
    return { id: t.id, table: t.table, label, type: t.type, columns }
  }

  const top = tables.filter((t) => t.cls === 'patient' || t.cls === 'visit' || t.cls === 'visit_detail').map((t) => toNode(t, t.table))
  const dicts = tables.filter((t) => t.cls === 'concept').map((t) => toNode(t, t.table))
  const events = tables.filter((t) => t.type === 'event').map((t) => toNode(t, t.key && t.key !== t.table ? `${t.table} (${t.key})` : t.table))

  const nodes: ErdNode[] = []
  const rows: Omit<ErdNode, 'x' | 'y'>[][] = []
  if (top.length) rows.push(top)
  for (let i = 0; i < dicts.length; i += MAX_PER_ROW) rows.push(dicts.slice(i, i + MAX_PER_ROW))
  for (let i = 0; i < events.length; i += MAX_PER_ROW) rows.push(events.slice(i, i + MAX_PER_ROW))

  const maxCols = Math.max(2, ...rows.map((r) => r.length))
  let y = MARGIN_Y
  for (const row of rows) {
    const offset = ((maxCols - row.length) / 2) * (NODE_W + COL_GAP)
    let rowH = 0
    row.forEach((n, i) => {
      const node: ErdNode = { ...n, x: MARGIN_X + offset + i * (NODE_W + COL_GAP), y }
      nodes.push(node)
      rowH = Math.max(rowH, nodeHeight(node))
    })
    y += rowH + ROW_GAP
  }
  return { nodes, edges }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function colY(node: ErdNode, colName: string): number | null {
  const i = node.columns.findIndex((c) => c.name === colName)
  return i < 0 ? null : node.y + HEADER_H + PAD_Y + i * ROW_H + ROW_H / 2
}

function renderNode(n: ErdNode, anchorId: (table: string) => string): string {
  const h = nodeHeight(n)
  const parts: string[] = [
    `<rect class="body" width="${NODE_W}" height="${h}" rx="8" />`,
    `<path class="head" d="M0 8a8 8 0 0 1 8-8h${NODE_W - 16}a8 8 0 0 1 8 8v${HEADER_H - 8}H0z" />`,
    svgIcon(TABLE_TYPE_ICON[n.type], 10, 8, 14, 'node-ico'),
    `<text class="label" x="30" y="19">${esc(truncate(n.label, 28))}</text>`,
  ]
  n.columns.forEach((c, i) => {
    const y = HEADER_H + PAD_Y + i * ROW_H
    if (c.role) {
      parts.push(`<g class="r-${c.role}"><rect x="10" y="${y + 3}" width="28" height="12" rx="3" /><text class="badge-text" x="24" y="${y + 11.5}" text-anchor="middle">${c.role.toUpperCase()}</text></g>`)
    }
    const tip = c.role === 'pk' ? 'Primary key' : c.fkTarget ? `FK → ${c.fkTarget}` : ''
    parts.push(`<text class="col" x="44" y="${y + 13}">${esc(truncate(c.name, 26))}${tip || c.name.length > 26 ? `<title>${esc(c.name)}${tip ? ` — ${esc(tip)}` : ''}</title>` : ''}</text>`)
  })
  parts.push(`<rect class="outline" width="${NODE_W}" height="${h}" rx="8" />`)
  return `<g class="node t-${n.type}" data-target="${esc(anchorId(n.table))}" transform="translate(${n.x} ${n.y})"><title>${esc(n.label)}</title>${parts.join('')}</g>`
}

/**
 * The diagram, or '' when the mapping names no table. `anchorId` gives the id of
 * the table's card in the column list, so a click on a node can scroll to it.
 */
export function renderSchemaErd(mapping: SchemaMapping, anchorId: (table: string) => string): string {
  const { nodes, edges } = buildGraph(mapping)
  if (!nodes.length) return ''
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const width = Math.max(...nodes.map((n) => n.x + NODE_W)) + MARGIN_X
  const height = Math.max(...nodes.map((n) => n.y + nodeHeight(n))) + MARGIN_Y

  const paths = edges.flatMap((e) => {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) return []
    const y1 = colY(a, e.fromCol)
    const y2 = colY(b, e.toCol)
    if (y1 == null || y2 == null) return []
    let x1: number, x2: number, c1: number, c2: number
    if (b.x > a.x + NODE_W) {
      x1 = a.x + NODE_W; x2 = b.x
      const d = Math.max(40, (x2 - x1) / 2)
      c1 = x1 + d; c2 = x2 - d
    } else if (b.x + NODE_W < a.x) {
      x1 = a.x; x2 = b.x + NODE_W
      const d = Math.max(40, (x1 - x2) / 2)
      c1 = x1 - d; c2 = x2 + d
    } else {
      // Stacked tables: loop out on the left rather than cut through either one.
      x1 = a.x; x2 = b.x
      c1 = c2 = Math.min(x1, x2) - 36
    }
    return [{ d: `M${x1} ${y1}C${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`, ends: [[x1, y1], [x2, y2]] }]
  })
  const edgeSvg = paths.map((p) => `<path class="edge" d="${p.d}" />`).join('')
  const handles = paths.flatMap((p) => p.ends.map(([x, y]) => `<circle class="handle" cx="${x}" cy="${y}" r="3.5" />`)).join('')

  return `<svg class="erd" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Entity-relationship diagram">${edgeSvg}${nodes.map((n) => renderNode(n, anchorId)).join('')}${handles}</svg>`
}
