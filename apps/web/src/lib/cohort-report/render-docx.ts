/**
 * The cohort report as a Word document, from the same model and the same SVG
 * charts as the HTML — rasterised, since Word does not take SVG reliably.
 * Loaded on demand: the `docx` library is only fetched when someone exports.
 */
import type { TFunction } from 'i18next'
import { flowchart, horizontalBars, verticalBars } from './charts'
import type { CohortReportModel } from './model'
import { LINKR_LOGO_SVG, type RenderOptions } from './render-html'

/** SVG → PNG bytes, with the size to show it at (CSS pixels). Injected, so the
 *  renderer runs outside a browser in tests. */
export type Rasterize = (svg: string) => Promise<{ data: Uint8Array; width: number; height: number }>

const BLUE = '004578'
const CYAN = '00A7D8'
const MUTED = '667892'
/** Printable width of an A4 page with 2 cm margins, in CSS pixels at 96 dpi. */
const PAGE_WIDTH_PX = 642

export async function renderReportDocx(
  model: CohortReportModel,
  t: TFunction,
  opts: RenderOptions,
  rasterize: Rasterize,
): Promise<Blob> {
  const d = await import('docx')
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, ShadingType } = d

  const image = async (svg: string, maxWidth = PAGE_WIDTH_PX) => {
    const png = await rasterize(svg)
    const scale = Math.min(1, maxWidth / png.width)
    return new Paragraph({
      children: [new ImageRun({
        type: 'png',
        data: png.data,
        transformation: { width: Math.round(png.width * scale), height: Math.round(png.height * scale) },
      })],
      spacing: { after: 120 },
    })
  }
  const text = (s: string, o: { size?: number; color?: string; bold?: boolean; italics?: boolean } = {}) =>
    new Paragraph({ children: [new TextRun({ text: s, size: o.size ?? 21, color: o.color, bold: o.bold, italics: o.italics })], spacing: { after: 120 } })
  const heading = (s: string) =>
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: s, color: BLUE, bold: true, size: 30 })], spacing: { before: 240, after: 120 } })
  const eyebrow = (s: string) =>
    new Paragraph({ children: [new TextRun({ text: s.toUpperCase(), color: CYAN, bold: true, size: 17 })], spacing: { before: 160, after: 80 } })
  const cell = (s: string, o: { head?: boolean; right?: boolean } = {}) => new TableCell({
    children: [new Paragraph({
      alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: s, bold: o.head, size: 18 })],
    })],
    ...(o.head ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF2F7' } } : {}),
  })
  const table = (head: { label: string; right?: boolean }[], rows: string[][]) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h) => cell(h.label, { head: true, right: h.right })) }),
      ...rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, { right: head[i]?.right })) })),
    ],
  })

  const date = new Date(model.generatedAt)
  const generated = t('cohort_report.generated_at', {
    date: date.toLocaleDateString(model.locale),
    time: date.toLocaleTimeString(model.locale, { hour: '2-digit', minute: '2-digit' }),
  })
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
  let n = 0
  const section = (title: string) => children.push(heading(`${++n}. ${title}`))

  children.push(await image(LINKR_LOGO_SVG.replace('width="40" height="35"', 'width="80" height="70"'), 48))
  children.push(eyebrow(t('cohort_report.eyebrow')))
  children.push(text(`${generated} · ${model.databaseName} · v${model.version}`, { size: 16, color: MUTED }))
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: model.title, bold: true, size: 44 })], spacing: { before: 240, after: 160 } }))
  if (model.description) {
    children.push(eyebrow(t('cohort_report.objective')))
    children.push(text(model.description))
  }

  section(t('cohort_report.section_counts'))
  children.push(table(
    model.kpis.map((k) => ({ label: k.label, right: true })),
    [model.kpis.map((k) => k.count.label)],
  ))

  if (model.flow.length > 1) {
    const withPatients = model.flow.some((f) => f.patients)
    section(t('cohort_report.section_flow'))
    children.push(await image(flowchart(model.flow.map((f) => ({
      label: f.label,
      counts: withPatients && f.patients
        ? `${f.units.label} ${model.unitLabel} · ${f.patients.label} ${t('cohort_report.patients_lower')}`
        : `${f.units.label} ${model.unitLabel}`,
    })), { title: t('cohort_report.section_flow') }), 520))
    children.push(text(t('cohort_report.flow_caption'), { size: 17, color: MUTED, italics: true }))
    children.push(table(
      [
        { label: t('cohort_report.col_step') },
        { label: model.unitLabel, right: true },
        ...(withPatients ? [{ label: t('cohort_report.kpi_patients'), right: true }] : []),
      ],
      model.flow.map((f) => [f.label, f.units.label, ...(withPatients ? [f.patients?.label ?? ''] : [])]),
    ))
  }

  if (model.criteria.length) {
    section(t('cohort_report.section_criteria'))
    for (const c of model.criteria) {
      children.push(new Paragraph({
        indent: { left: c.depth * 360 },
        children: [
          ...(c.operator ? [new TextRun({ text: `${t(`cohort_report.op_${c.operator}`)}  `, bold: true, color: CYAN, size: 18 })] : []),
          new TextRun({ text: c.text, size: 21 }),
        ],
        spacing: { after: 80 },
      }))
    }
  }

  if (model.concepts.length) {
    section(t('cohort_report.section_concepts'))
    children.push(text(t('cohort_report.concepts_intro')))
    children.push(table(
      [
        { label: t('cohort_report.col_table') },
        { label: t('cohort_report.col_code') },
        { label: t('cohort_report.col_label') },
        { label: t('cohort_report.col_rows'), right: true },
        { label: t('cohort_report.kpi_patients'), right: true },
        { label: t('cohort_report.col_coverage'), right: true },
      ],
      model.concepts.map((c) => [c.table, String(c.conceptId), c.name, c.rows.label, c.patients.label, c.coverage ?? '—']),
    ))
  }

  if (model.age.length || model.sex.length || model.months.length) {
    section(t('cohort_report.section_characteristics'))
    if (model.age.length) {
      children.push(eyebrow(t('cohort_report.chart_age')))
      children.push(await image(verticalBars(model.age, { title: t('cohort_report.chart_age'), height: 200 })))
    }
    if (model.sex.length) {
      children.push(eyebrow(t('cohort_report.chart_sex')))
      children.push(await image(horizontalBars(model.sex, { title: t('cohort_report.chart_sex') })))
    }
    if (model.months.length) {
      const title = t('cohort_report.chart_months', { unit: model.unitLabel })
      children.push(eyebrow(title))
      children.push(await image(verticalBars(model.months, { title })))
    }
    children.push(text(t('cohort_report.suppression_caption', { threshold: model.threshold }), { size: 17, color: MUTED, italics: true }))
  }

  if (model.eventTables.length || model.careUnits.length || model.years.length) {
    section(t('cohort_report.section_data'))
    if (model.eventTables.length) {
      children.push(text(t('cohort_report.event_tables_intro')))
      children.push(table(
        [
          { label: t('cohort_report.col_table') },
          { label: t('cohort_report.col_rows'), right: true },
          { label: t('cohort_report.kpi_patients'), right: true },
        ],
        model.eventTables.map((e) => [e.label, e.rows.label, e.patients.label]),
      ))
    }
    if (model.careUnits.length) {
      children.push(eyebrow(t('cohort_report.chart_units')))
      children.push(await image(horizontalBars(model.careUnits.slice(0, 25), { title: t('cohort_report.chart_units') })))
      children.push(text(t('cohort_report.units_caption'), { size: 17, color: MUTED, italics: true }))
    }
    if (model.years.length) {
      children.push(eyebrow(t('cohort_report.years_title')))
      children.push(table(
        [
          { label: t('cohort_report.col_year') },
          { label: model.unitLabel, right: true },
          { label: t('cohort_report.kpi_patients'), right: true },
        ],
        model.years.map((y) => [y.year, y.units.label, y.patients.label]),
      ))
    }
  }

  section(t('cohort_report.section_methods'))
  children.push(text(t('cohort_report.methods_text', { unit: model.unitLabel, database: model.databaseName })))
  children.push(text(t('cohort_report.suppression_text', { threshold: model.threshold })))
  if (opts.includeSql) {
    children.push(eyebrow('SQL'))
    for (const line of model.sql.split('\n')) {
      children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 15 })] }))
    }
  }
  children.push(text(t('cohort_report.footer'), { size: 16, color: MUTED }))

  const doc = new Document({
    creator: 'Linkr',
    title: `${t('cohort_report.eyebrow')} — ${model.title}`,
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  })
  return Packer.toBlob(doc)
}
