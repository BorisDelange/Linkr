/**
 * The quality report as one self-contained HTML file, on the cohort report's
 * stylesheet and masthead: no network request, prints to an A4 PDF.
 */
import type { TFunction } from 'i18next'
import { escapeXml as esc } from '@/lib/cohort-report/charts'
import { LINKR_LOGO_SVG, STYLE, highlightSql, table } from '@/lib/cohort-report/render-html'
import { formatDuration } from '@/lib/format-helpers'
import { STATUS_HEX, statusBars } from './charts'
import type { DqReportModel } from './model'
import { scoreOf, type DqTally } from './tally'

const DQ_STYLE = `
.check{border:1px solid var(--line);border-left:3px solid var(--line);padding:10px 12px;margin:0 0 10px;break-inside:avoid}
.check h4{font-size:13px;color:var(--ink);margin:0 0 4px}
.check .meta{font-size:11px;color:var(--muted);margin:0 0 6px}
.check p{margin:0 0 6px}
.check .figures{font-size:11.5px;font-variant-numeric:tabular-nums}
.check .err{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#9b1c1c;background:#fdecec;padding:6px 8px;white-space:pre-wrap;overflow-wrap:anywhere}
.chip{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;color:#fff;margin-right:6px}
.kpi.score .v{font-size:30px}
`

/** The labels both renderers share. */
export function reportLabels(model: DqReportModel, t: TFunction) {
  const date = new Date(model.generatedAt)
  const runAt = new Date(model.runAt)
  return {
    eyebrow: t('dq_report.eyebrow'),
    generated: t('cohort_report.generated_at', {
      date: date.toLocaleDateString(model.locale),
      time: date.toLocaleTimeString(model.locale, { hour: '2-digit', minute: '2-digit' }),
    }),
    runAt: t('dq_report.run_at', {
      date: runAt.toLocaleDateString(model.locale),
      time: runAt.toLocaleTimeString(model.locale, { hour: '2-digit', minute: '2-digit' }),
    }),
  }
}

/** Label → value lines describing what was run. */
export function sourceRows(model: DqReportModel, t: TFunction): [string, string][] {
  const { runAt } = reportLabels(model, t)
  return [
    [t('dq_report.source_database'), model.databaseName],
    [t('dq_report.source_run'), runAt],
    [t('dq_report.source_duration'), formatDuration(model.durationMs)],
    ...(model.version ? [[t('dq_report.source_profile_version'), model.version] as [string, string]] : []),
  ]
}

/** The KPI tiles: score, then the checks by status. */
export function kpis(model: DqReportModel, t: TFunction): { label: string; value: string; score?: boolean }[] {
  const n = (v: number) => v.toLocaleString(model.locale)
  return [
    { label: t('dq_report.kpi_score'), value: model.score == null ? '—' : `${model.score}%`, score: true },
    { label: t('data_quality.status_pass'), value: n(model.tally.passed) },
    { label: t('data_quality.status_fail'), value: n(model.tally.failed) },
    { label: t('data_quality.status_error'), value: n(model.tally.errors) },
    { label: t('data_quality.status_not_applicable'), value: n(model.tally.notApplicable) },
  ]
}

export function dimensionChart(model: DqReportModel, t: TFunction): string {
  return statusBars(model.byDimension, { title: t('dq_report.chart_dimensions'), statusLabel: (s) => t(`data_quality.status_${s}`) })
}

export function severityChart(model: DqReportModel, t: TFunction): string {
  return statusBars(model.bySeverity, { title: t('dq_report.chart_severities'), statusLabel: (s) => t(`data_quality.status_${s}`) })
}

/** One row of a counts table: total, by status, score. */
export function tallyCells(tally: DqTally, locale: string): string[] {
  const score = scoreOf(tally)
  return [tally.total, tally.passed, tally.failed, tally.errors, tally.notApplicable]
    .map((v) => v.toLocaleString(locale))
    .concat(score == null ? '—' : `${score}%`)
}

export function tallyHead(t: TFunction): { label: string; right?: boolean }[] {
  return [
    { label: t('dq_report.col_checks'), right: true },
    { label: t('data_quality.status_pass'), right: true },
    { label: t('data_quality.status_fail'), right: true },
    { label: t('data_quality.status_error'), right: true },
    { label: t('data_quality.status_not_applicable'), right: true },
    { label: t('dq_report.kpi_score'), right: true },
  ]
}

const docUrl = (lang: string) => `https://linkr.interhop.org/${lang === 'fr' ? '' : 'en/'}docs`

export function renderDqReportHtml(model: DqReportModel, t: TFunction): string {
  const labels = reportLabels(model, t)
  const sections: { title: string; body: string }[] = []

  const tiles = kpis(model, t)
  sections.push({
    title: t('dq_report.section_summary'),
    body: `<div class="kpis" style="--cols:${tiles.length}">${tiles
      .map((k) => `<div class="kpi${k.score ? ' score' : ''}"><div class="v num">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></div>`)
      .join('')}</div>`
      + `<p class="caption">${esc(t('dq_report.score_caption'))}</p>`
      + `<h3>${esc(t('dq_report.chart_dimensions'))}</h3><div class="figure">${dimensionChart(model, t)}</div>`
      + `<h3>${esc(t('dq_report.chart_severities'))}</h3><div class="figure">${severityChart(model, t)}</div>`,
  })

  if (model.ruleSets.length) {
    sections.push({
      title: t('dq_report.section_rule_sets'),
      body: `<p>${esc(t('dq_report.rule_sets_intro'))}</p>` + table(
        [{ label: t('data_quality.col_rule_set') }, { label: t('dq_report.col_version') }, { label: t('dq_report.col_checks'), right: true }],
        model.ruleSets.map((r) => [esc(r.name), esc(r.version), r.checks.toLocaleString(model.locale)]),
      ),
    })
  }

  if (model.groups.length) {
    sections.push({
      title: t('dq_report.section_groups'),
      body: table(
        [{ label: t('data_quality.col_group') }, ...tallyHead(t)],
        model.groups.map((g) => [
          `<span style="padding-left:${g.depth * 14}px;${g.depth === 0 ? 'font-weight:600' : ''}">${esc(g.label)}</span>`,
          ...tallyCells(g.tally, model.locale),
        ]),
      ),
    })
  }

  sections.push({
    title: t(model.includePassed ? 'dq_report.section_checks' : 'dq_report.section_failures'),
    body: model.checks.length
      ? model.checks.map((c) => `<div class="check" style="border-left-color:${STATUS_HEX[c.status]}">`
        + `<h4><span class="chip" style="background:${STATUS_HEX[c.status]}">${esc(c.statusLabel)}</span>${esc(c.name)}</h4>`
        + `<div class="meta">${[c.ruleSet, c.group, c.dimensionLabel, c.severityLabel].filter(Boolean).map((v) => esc(v!)).join(' · ')}</div>`
        + (c.description ? `<p>${esc(c.description)}</p>` : '')
        + `<div class="figures">${c.violated != null
          ? esc(t('dq_report.check_figures', { violated: c.violated, threshold: c.threshold, rows: c.rows }))
          : esc(t('dq_report.check_threshold', { threshold: c.threshold }))}</div>`
        + (c.error ? `<p class="err">${esc(c.error)}</p>` : '')
        + (c.sql ? `<pre class="sql">${highlightSql(c.sql)}</pre>` : '')
        + '</div>').join('')
      : `<p>${esc(t('dq_report.no_failures'))}</p>`,
  })

  sections.push({
    title: t('dq_report.section_methods'),
    body: `<table class="source"><tbody>${sourceRows(model, t)
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`
      + `<p>${esc(t('dq_report.methods_text'))}</p>`,
  })

  const lang = model.locale.slice(0, 2)
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(labels.eyebrow)} — ${esc(model.title)}</title>
<style>${STYLE}${DQ_STYLE}</style>
</head>
<body>
<div class="page">
<header class="brand">${LINKR_LOGO_SVG}<div class="brand-t"><h1>${esc(model.title)}</h1><div class="eyebrow">${esc(labels.eyebrow)}</div></div></header>
<div class="objective"><p>${esc(t('dq_report.intro', { database: model.databaseName, date: labels.runAt }))}</p>${model.description ? `<p>${esc(model.description)}</p>` : ''}</div>
${sections.map((s, i) => `<section><h2>${i + 1}. ${esc(s.title)}</h2>${s.body}</section>`).join('\n')}
<footer>
  <span>${[labels.generated, model.databaseName, ...(model.version ? [`v${model.version}`] : [])].map(esc).join(' · ')}</span>
  <span>${esc(t('cohort_report.generated_with'))} <a href="${docUrl(lang)}" target="_blank" rel="noopener">Linkr</a></span>
</footer>
</div>
</body>
</html>
`
}
