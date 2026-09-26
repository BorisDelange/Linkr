/**
 * The Schemas page ERD (`features/warehouse/SchemaERD.tsx`) as a static SVG,
 * for the standalone catalog page where ReactFlow is not available. Same rows
 * (patient + visit, concept dictionaries, event tables), same per-type colours
 * and role badges, edges drawn from the FK column to the PK it references.
 * Colours come from CSS classes so the page's dark mode applies.
 */
import type { SchemaMapping } from '@/types'
import { escapeXml as esc } from '@/lib/cohort-report/charts'
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

/** Role of each mapped column, per table: shared by the ERD and the column list. */
export function mappingColumnRoles(mapping: SchemaMapping): Map<string, Map<string, ColumnRole>> {
  const roles = new Map<string, Map<string, ColumnRole>>()
  const set = (table: string, col: string | undefined, role: ColumnRole) => {
    if (!col) return
    if (!roles.has(table)) roles.set(table, new Map())
    const cols = roles.get(table)!
    if (!cols.has(col)) cols.set(col, role)
  }
  const pt = mapping.patientTable
  if (pt) {
    set(pt.table, pt.idColumn, 'pk')
    set(pt.table, pt.birthDateColumn, 'date')
    set(pt.table, pt.deathDateColumn, 'date')
  }
  const vt = mapping.visitTable
  if (vt) {
    set(vt.table, vt.idColumn, 'pk')
    set(vt.table, vt.patientIdColumn, 'fk')
    set(vt.table, vt.startDateColumn, 'date')
    set(vt.table, vt.endDateColumn, 'date')
  }
  const vd = mapping.visitDetailTable
  if (vd) {
    set(vd.table, vd.idColumn, 'pk')
    set(vd.table, vd.visitIdColumn, 'fk')
    set(vd.table, vd.patientIdColumn, 'fk')
    set(vd.table, vd.startDateColumn, 'date')
    set(vd.table, vd.endDateColumn, 'date')
  }
  for (const cd of mapping.conceptTables ?? []) set(cd.table, cd.idColumn, 'pk')
  for (const et of Object.values(mapping.eventTables ?? {})) {
    set(et.table, et.conceptIdColumn, 'fk')
    set(et.table, et.sourceConceptIdColumn, 'fk')
    set(et.table, et.patientIdColumn, 'fk')
    set(et.table, et.valueColumn, 'value')
    set(et.table, et.valueStringColumn, 'value')
    set(et.table, et.dateColumn, 'date')
  }
  return roles
}

/** Display type of each mapped table (visit detail shares the visit colour). */
export function mappingTableTypes(mapping: SchemaMapping): Map<string, TableType> {
  const types = new Map<string, TableType>()
  for (const et of Object.values(mapping.eventTables ?? {})) types.set(et.table, 'event')
  for (const cd of mapping.conceptTables ?? []) types.set(cd.table, 'concept')
  if (mapping.visitDetailTable) types.set(mapping.visitDetailTable.table, 'visit')
  if (mapping.visitTable) types.set(mapping.visitTable.table, 'visit')
  if (mapping.patientTable) types.set(mapping.patientTable.table, 'patient')
  return types
}

function buildGraph(mapping: SchemaMapping): { nodes: ErdNode[]; edges: ErdEdge[] } {
  const nodes: ErdNode[] = []
  const edges: ErdEdge[] = []
  const pt = mapping.patientTable
  const vt = mapping.visitTable
  const patientRef = pt ? `${pt.table}.${pt.idColumn}` : undefined

  const top: Omit<ErdNode, 'x' | 'y'>[] = []
  if (pt) {
    const columns: ErdColumn[] = [{ name: pt.idColumn, role: 'pk' }]
    if (pt.birthDateColumn) columns.push({ name: pt.birthDateColumn, role: 'date' })
    for (const c of [pt.birthYearColumn, pt.anchorAgeColumn, pt.anchorYearColumn, pt.genderColumn]) {
      if (c) columns.push({ name: c })
    }
    top.push({ id: 'patient', table: pt.table, label: pt.table, type: 'patient', columns })
  }
  if (vt) {
    const columns: ErdColumn[] = [
      { name: vt.idColumn, role: 'pk' },
      { name: vt.patientIdColumn, role: 'fk', fkTarget: patientRef },
      { name: vt.startDateColumn, role: 'date' },
    ]
    if (vt.endDateColumn) columns.push({ name: vt.endDateColumn, role: 'date' })
    top.push({ id: 'visit', table: vt.table, label: vt.table, type: 'visit', columns })
    if (pt) edges.push({ from: 'visit', fromCol: vt.patientIdColumn, to: 'patient', toCol: pt.idColumn })
  }

  const dicts = (mapping.conceptTables ?? []).map((d): Omit<ErdNode, 'x' | 'y'> => {
    const columns: ErdColumn[] = [{ name: d.idColumn ?? '', role: 'pk' }, { name: d.nameColumn }]
    if (d.codeColumn) columns.push({ name: d.codeColumn })
    if (d.vocabularyColumn) columns.push({ name: d.vocabularyColumn })
    for (const c of Object.values(d.extraColumns ?? {})) columns.push({ name: c })
    return { id: `concept-${d.key}`, table: d.table, label: d.table, type: 'concept', columns }
  })

  const events = Object.entries(mapping.eventTables ?? {}).map(([label, et]): Omit<ErdNode, 'x' | 'y'> => {
    const dictKey = et.conceptDictionaryKey ?? mapping.conceptTables?.[0]?.key
    const dict = mapping.conceptTables?.find((d) => d.key === dictKey)
    const columns: ErdColumn[] = [{
      name: et.conceptIdColumn, role: 'fk',
      fkTarget: dict ? `${dict.table}.${dict.idColumn ?? ''}` : undefined,
    }]
    if (et.sourceConceptIdColumn) columns.push({ name: et.sourceConceptIdColumn, role: 'fk' })
    if (et.patientIdColumn) columns.push({ name: et.patientIdColumn, role: 'fk', fkTarget: patientRef })
    if (et.valueColumn) columns.push({ name: et.valueColumn, role: 'value' })
    if (et.valueStringColumn) columns.push({ name: et.valueStringColumn, role: 'value' })
    if (et.dateColumn) columns.push({ name: et.dateColumn, role: 'date' })
    const id = `event-${label}`
    if (dict) edges.push({ from: id, fromCol: et.conceptIdColumn, to: `concept-${dict.key}`, toCol: dict.idColumn ?? '' })
    if (et.patientIdColumn && pt) edges.push({ from: id, fromCol: et.patientIdColumn, to: 'patient', toCol: pt.idColumn })
    return { id, table: et.table, label: `${et.table} (${label})`, type: 'event', columns }
  })

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
