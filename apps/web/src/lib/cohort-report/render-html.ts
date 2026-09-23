/**
 * The cohort report as one self-contained HTML file: inline CSS, inline SVG,
 * the logo inlined, no network request — it opens identically offline, as an
 * e-mail attachment. The same file prints to an A4 PDF (the print stylesheet is
 * part of it), which is how the PDF export is made.
 */
import type { TFunction } from 'i18next'
import { escapeXml, flowchart, horizontalBars, verticalBars } from './charts'
import type { CohortReportModel } from './model'

/** The Linkr mark (`public/favicon.svg`), inlined so the file stays self-contained. */
export const LINKR_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 88" width="40" height="35" aria-label="Linkr"><defs><linearGradient id="linkr-top" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#00d4ff"/><stop offset="100%" stop-color="#2196F3"/></linearGradient></defs><polygon points="5.3,0.4 94.7,0.8 49.8,26.6" fill="url(#linkr-top)"/><polygon points="0.9,9.9 45.5,35.4 45.5,86.9" fill="#004578"/><polygon points="98.6,9.7 54.1,35.4 54.1,86.8" fill="#0084d8"/></svg>`

const esc = escapeXml

const STYLE = `
:root{--ink:#0f1b2d;--text:#33445c;--muted:#667892;--line:#cdd7e3;--soft:#eef2f7;--blue:#004578;--blue2:#0084d8;--cyan:#00a7d8;}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#dde4ec;font-family:system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:var(--text)}
.page{width:210mm;min-height:297mm;margin:24px auto;padding:14mm;background:#fff;box-shadow:0 12px 32px rgba(15,27,45,.14)}
.num{font-variant-numeric:tabular-nums}
header{display:flex;align-items:center;gap:12px;padding-bottom:10px;border-bottom:2px solid var(--blue)}
header .eyebrow{font-weight:600;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--cyan)}
header .meta{font-size:9px;color:var(--muted);margin-top:2px}
h1{font-size:26px;line-height:1.15;color:var(--ink);margin:22px 0 10px;letter-spacing:-.01em}
h2{font-size:19px;color:var(--blue);margin:0 0 10px;padding-bottom:6px;border-bottom:2px solid #d8e7f3;break-after:avoid}
h3{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--cyan);margin:14px 0 8px;break-after:avoid}
p,li{font-size:13px;line-height:1.6}
p{margin:0 0 10px}
section{margin-bottom:26px}
.figure{break-inside:avoid;margin:6px 0 12px}
.figure svg{max-width:100%;height:auto}
.caption{font-size:11px;color:var(--muted);margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(var(--cols,3),1fr);gap:12px}
.kpi{border:1px solid var(--line);border-top:3px solid var(--blue2);padding:14px 16px;text-align:center}
.kpi .v{font-size:26px;font-weight:600;color:var(--blue);line-height:1}
.kpi .l{font-size:11px;color:var(--muted);margin-top:6px}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:11.5px;margin:4px 0 10px}
th{text-align:left;font-weight:600;color:var(--ink);background:var(--soft);padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:5px 8px;border-bottom:1px solid var(--soft);vertical-align:top;overflow-wrap:anywhere}
tr{break-inside:avoid}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
.crit{list-style:none;padding:0}
.crit li{padding:4px 0}
.crit .op{display:inline-block;min-width:34px;font-size:10px;font-weight:600;color:var(--cyan)}
pre{font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-size:9.5px;line-height:1.45;background:var(--soft);padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:auto}
footer{margin-top:26px;padding-top:8px;border-top:1px solid var(--line);font-size:9px;color:var(--muted);text-align:center}
@page{size:A4;margin:14mm}
@media print{body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
`

function table(head: { label: string; right?: boolean }[], rows: string[][]): string {
  const th = head.map((h) => `<th${h.right ? ' class="r"' : ''}>${esc(h.label)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td${head[i]?.right ? ' class="r"' : ''}>${c}</td>`).join('')}</tr>`)
    .join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`
}

export interface RenderOptions {
  /** Append the membership SQL under Methodology. */
  includeSql: boolean
}

export function renderReportHtml(model: CohortReportModel, t: TFunction, opts: RenderOptions): string {
  const date = new Date(model.generatedAt)
  const generated = t('cohort_report.generated_at', {
    date: date.toLocaleDateString(model.locale),
    time: date.toLocaleTimeString(model.locale, { hour: '2-digit', minute: '2-digit' }),
  })
  const sections: { title: string; body: string }[] = []

  sections.push({
    title: t('cohort_report.section_counts'),
    body: `<div class="kpis" style="--cols:${model.kpis.length}">${model.kpis
      .map((k) => `<div class="kpi"><div class="v num">${esc(k.count.label)}</div><div class="l">${esc(k.label)}</div></div>`)
      .join('')}</div>`,
  })

  if (model.flow.length > 1) {
    const withPatients = model.flow.some((f) => f.patients)
    const steps = model.flow.map((f) => ({
      label: f.label,
      counts: withPatients && f.patients
        ? `${f.units.label} ${model.unitLabel} · ${f.patients.label} ${t('cohort_report.patients_lower')}`
        : `${f.units.label} ${model.unitLabel}`,
    }))
    const head = [
      { label: t('cohort_report.col_step') },
      { label: model.unitLabel, right: true },
      ...(withPatients ? [{ label: t('cohort_report.kpi_patients'), right: true }] : []),
    ]
    const rows = model.flow.map((f) => [
      esc(f.label),
      esc(f.units.label),
      ...(withPatients ? [esc(f.patients?.label ?? '')] : []),
    ])
    sections.push({
      title: t('cohort_report.section_flow'),
      body: `<div class="figure">${flowchart(steps, { title: t('cohort_report.section_flow') })}</div>`
        + `<p class="caption">${esc(t('cohort_report.flow_caption'))}</p>${table(head, rows)}`,
    })
  }

  if (model.criteria.length) {
    sections.push({
      title: t('cohort_report.section_criteria'),
      body: `<ul class="crit">${model.criteria
        .map((c) => `<li style="padding-left:${c.depth * 18}px"><span class="op">${c.operator ? esc(t(`cohort_report.op_${c.operator}`)) : ''}</span>${esc(c.text)}</li>`)
        .join('')}</ul>`,
    })
  }

  if (model.concepts.length) {
    sections.push({
      title: t('cohort_report.section_concepts'),
      body: `<p>${esc(t('cohort_report.concepts_intro'))}</p>` + table(
        [
          { label: t('cohort_report.col_table') },
          { label: t('cohort_report.col_code') },
          { label: t('cohort_report.col_label') },
          { label: t('cohort_report.col_rows'), right: true },
          { label: t('cohort_report.kpi_patients'), right: true },
          { label: t('cohort_report.col_coverage'), right: true },
        ],
        model.concepts.map((c) => [
          esc(c.table), `<span class="num">${c.conceptId}</span>`, esc(c.name),
          esc(c.rows.label), esc(c.patients.label), esc(c.coverage ?? '—'),
        ]),
      ),
    })
  }

  const characteristics: string[] = []
  if (model.age.length) {
    characteristics.push(`<h3>${esc(t('cohort_report.chart_age'))}</h3><div class="figure">${verticalBars(model.age, { title: t('cohort_report.chart_age'), height: 200 })}</div>`)
  }
  if (model.sex.length) {
    characteristics.push(`<h3>${esc(t('cohort_report.chart_sex'))}</h3><div class="figure">${horizontalBars(model.sex, { title: t('cohort_report.chart_sex') })}</div>`)
  }
  if (model.months.length) {
    characteristics.push(`<h3>${esc(t('cohort_report.chart_months', { unit: model.unitLabel }))}</h3><div class="figure">${verticalBars(model.months, { title: t('cohort_report.chart_months', { unit: model.unitLabel }) })}</div>`)
  }
  if (characteristics.length) {
    sections.push({
      title: t('cohort_report.section_characteristics'),
      body: characteristics.join('') + `<p class="caption">${esc(t('cohort_report.suppression_caption', { threshold: model.threshold }))}</p>`,
    })
  }

  const data: string[] = []
  if (model.eventTables.length) {
    data.push(`<p>${esc(t('cohort_report.event_tables_intro'))}</p>` + table(
      [
        { label: t('cohort_report.col_table') },
        { label: t('cohort_report.col_rows'), right: true },
        { label: t('cohort_report.kpi_patients'), right: true },
      ],
      model.eventTables.map((e) => [esc(e.label), esc(e.rows.label), esc(e.patients.label)]),
    ))
  }
  if (model.careUnits.length) {
    data.push(`<h3>${esc(t('cohort_report.chart_units'))}</h3><div class="figure">${horizontalBars(model.careUnits.slice(0, 25), { title: t('cohort_report.chart_units') })}</div><p class="caption">${esc(t('cohort_report.units_caption'))}</p>`)
  }
  if (model.years.length) {
    data.push(`<h3>${esc(t('cohort_report.years_title'))}</h3>` + table(
      [
        { label: t('cohort_report.col_year') },
        { label: model.unitLabel, right: true },
        { label: t('cohort_report.kpi_patients'), right: true },
      ],
      model.years.map((y) => [esc(y.year), esc(y.units.label), esc(y.patients.label)]),
    ))
  }
  if (data.length) sections.push({ title: t('cohort_report.section_data'), body: data.join('') })

  sections.push({
    title: t('cohort_report.section_methods'),
    body: `<p>${esc(t('cohort_report.methods_text', { unit: model.unitLabel, database: model.databaseName }))}</p>`
      + `<p>${esc(t('cohort_report.suppression_text', { threshold: model.threshold }))}</p>`
      + (opts.includeSql ? `<h3>SQL</h3><pre>${esc(model.sql)}</pre>` : ''),
  })

  const lang = model.locale.slice(0, 2)
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('cohort_report.eyebrow'))} — ${esc(model.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header>${LINKR_LOGO_SVG}<div><div class="eyebrow">${esc(t('cohort_report.eyebrow'))}</div><div class="meta">${esc(generated)} · ${esc(model.databaseName)} · v${esc(model.version)}</div></div></header>
<h1>${esc(model.title)}</h1>
${model.description ? `<h3>${esc(t('cohort_report.objective'))}</h3><p>${esc(model.description)}</p>` : ''}
${sections.map((s, i) => `<section><h2>${i + 1}. ${esc(s.title)}</h2>${s.body}</section>`).join('\n')}
<footer>${esc(t('cohort_report.footer'))}</footer>
</div>
</body>
</html>
`
}
