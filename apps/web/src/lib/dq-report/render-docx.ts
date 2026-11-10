/**
 * The quality report as a Word document, from the same model and the same SVG
 * chart as the HTML, rasterised. Loaded on demand with the `docx` library.
 */
import type { TFunction } from 'i18next'
import { LINKR_LOGO_SVG } from '@/lib/cohort-report/render-html'
import type { Rasterize } from '@/lib/cohort-report/render-docx'
import { SQL_COLORS, tokenizeSql } from '@/lib/cohort-report/sql-highlight'
import { STATUS_HEX } from './charts'
import type { DqReportModel } from './model'
import { dimensionChart, kpis, reportLabels, severityChart, sourceRows, tallyCells, tallyHead } from './render-html'

const BLUE = '004578'
const CYAN = '00A7D8'
const MUTED = '667892'
/** Printable width of an A4 page with 2 cm margins, in CSS pixels at 96 dpi. */
const PAGE_WIDTH_PX = 642

export async function renderDqReportDocx(model: DqReportModel, t: TFunction, rasterize: Rasterize): Promise<Blob> {
  const d = await import('docx')
  const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, ShadingType, BorderStyle } = d

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
    new Paragraph({
      ...(o.size == null ? { alignment: AlignmentType.JUSTIFIED } : {}),
      children: [new TextRun({ text: s, size: o.size ?? 21, color: o.color, bold: o.bold, italics: o.italics })],
      spacing: { after: 120 },
    })
  const heading = (s: string) =>
    new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: s, color: BLUE, bold: true, size: 30 })], spacing: { before: 240, after: 120 } })
  const eyebrow = (s: string) =>
    new Paragraph({ children: [new TextRun({ text: s.toUpperCase(), color: CYAN, bold: true, size: 17 })], spacing: { before: 160, after: 80 } })
  const cell = (s: string, o: { head?: boolean; right?: boolean; indent?: number; bold?: boolean } = {}) => new TableCell({
    children: [new Paragraph({
      alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      ...(o.indent ? { indent: { left: o.indent * 200 } } : {}),
      children: [new TextRun({ text: s, bold: o.head || o.bold, size: 18 })],
    })],
    ...(o.head ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF2F7' } } : {}),
  })
  const table = (head: { label: string; right?: boolean }[], rows: string[][], firstIndent?: number[]) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: head.map((h) => cell(h.label, { head: true, right: h.right })) }),
      ...rows.map((r, ri) => new TableRow({
        children: r.map((c, i) => cell(c, { right: head[i]?.right, ...(i === 0 && firstIndent ? { indent: firstIndent[ri], bold: firstIndent[ri] === 0 } : {}) })),
      })),
    ],
  })

  const labels = reportLabels(model, t)
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
  let n = 0
  const section = (title: string) => children.push(heading(`${++n}. ${title}`))

  children.push(await image(LINKR_LOGO_SVG.replace('width="40" height="35"', 'width="80" height="70"'), 48))
  children.push(eyebrow(labels.eyebrow))
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: model.title, bold: true, size: 40 })], spacing: { before: 240, after: 240 } }))
  children.push(text(t('dq_report.intro', { database: model.databaseName, date: labels.runAt })))
  if (model.description) children.push(text(model.description))

  section(t('dq_report.section_summary'))
  const tiles = kpis(model, t)
  children.push(table(tiles.map((k) => ({ label: k.label, right: true })), [tiles.map((k) => k.value)]))
  children.push(text(t('dq_report.score_caption'), { size: 17, color: MUTED, italics: true }))
  children.push(eyebrow(t('dq_report.chart_dimensions')))
  children.push(await image(dimensionChart(model, t)))
  children.push(eyebrow(t('dq_report.chart_severities')))
  children.push(await image(severityChart(model, t)))

  if (model.ruleSets.length) {
    section(t('dq_report.section_rule_sets'))
    children.push(text(t('dq_report.rule_sets_intro')))
    children.push(table(
      [{ label: t('data_quality.col_rule_set') }, { label: t('dq_report.col_version') }, { label: t('dq_report.col_checks'), right: true }],
      model.ruleSets.map((r) => [r.name, r.version, r.checks.toLocaleString(model.locale)]),
    ))
  }

  if (model.groups.length) {
    section(t('dq_report.section_groups'))
    children.push(table(
      [{ label: t('data_quality.col_group') }, ...tallyHead(t)],
      model.groups.map((g) => [g.label, ...tallyCells(g.tally, model.locale)]),
      model.groups.map((g) => g.depth),
    ))
  }

  section(t(model.includePassed ? 'dq_report.section_checks' : 'dq_report.section_failures'))
  if (!model.checks.length) children.push(text(t('dq_report.no_failures')))
  for (const c of model.checks) {
    children.push(new Paragraph({
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: STATUS_HEX[c.status].slice(1), space: 6 } },
      children: [
        new TextRun({ text: `${c.statusLabel}  `, bold: true, color: STATUS_HEX[c.status].slice(1), size: 18 }),
        new TextRun({ text: c.name, bold: true, size: 22 }),
      ],
      spacing: { before: 200, after: 60 },
    }))
    children.push(text([c.ruleSet, c.group, c.dimensionLabel, c.severityLabel].filter(Boolean).join(' · '), { size: 17, color: MUTED }))
    if (c.description) children.push(text(c.description))
    children.push(text(c.violated != null
      ? t('dq_report.check_figures', { violated: c.violated, threshold: c.threshold, rows: c.rows })
      : t('dq_report.check_threshold', { threshold: c.threshold }), { size: 19 }))
    if (c.error) children.push(new Paragraph({ children: [new TextRun({ text: c.error, font: 'Consolas', size: 15, color: '9B1C1C' })], spacing: { after: 120 } }))
    if (c.sql) {
      for (const line of c.sql.split('\n')) {
        children.push(new Paragraph({
          children: line
            ? tokenizeSql(line).map((tok) => new TextRun({
                text: tok.text,
                font: 'Consolas',
                size: 15,
                ...(tok.kind !== 'plain' ? { color: SQL_COLORS[tok.kind].slice(1) } : {}),
                ...(tok.kind === 'keyword' ? { bold: true } : {}),
                ...(tok.kind === 'comment' ? { italics: true } : {}),
              }))
            : [new TextRun({ text: ' ', font: 'Consolas', size: 15 })],
        }))
      }
    }
  }

  section(t('dq_report.section_methods'))
  children.push(new Table({
    width: { size: 60, type: WidthType.PERCENTAGE },
    rows: sourceRows(model, t).map(([k, v]) => new TableRow({ children: [cell(k), cell(v)] })),
  }))
  children.push(text(t('dq_report.methods_text')))
  children.push(text(`${labels.generated} · ${t('cohort_report.footer')}`, { size: 16, color: MUTED }))

  const doc = new Document({
    creator: 'Linkr',
    title: `${labels.eyebrow} — ${model.title}`,
    styles: { default: { document: { run: { font: 'Calibri' } } } },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  })
  return Packer.toBlob(doc)
}
