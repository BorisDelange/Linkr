/**
 * The app's cohort report, rendered for a chat client: the same model and HTML
 * the report dialog builds, plus a text summary for the model to read.
 *
 * The HTML travels as an MCP-UI resource (`ui://…`, `text/html`): LibreChat
 * renders it inline in a sandboxed iframe and never passes it to the model, so
 * a full report costs the conversation only its summary.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createInstance, type TFunction } from 'i18next'
import type { CohortReportModel } from '@/lib/cohort-report/model'

export const REPORT_LANGUAGES = ['en', 'fr'] as const
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number]

const LOCALES_DIR = fileURLToPath(new URL('../../../../apps/web/src/locales/', import.meta.url))

const translators = new Map<ReportLanguage, TFunction>()

/** The app's own translations, so the report reads exactly as it does in Linkr. */
export async function reportTranslator(language: ReportLanguage): Promise<TFunction> {
  const cached = translators.get(language)
  if (cached) return cached
  const i18n = createInstance()
  const resources = Object.fromEntries(REPORT_LANGUAGES.map((l) => [
    l, { translation: JSON.parse(readFileSync(`${LOCALES_DIR}${l}.json`, 'utf8')) as Record<string, unknown> },
  ]))
  const t = await i18n.init({
    lng: language, fallbackLng: 'en', resources, interpolation: { escapeValue: false },
    // Its banner goes to stdout, which is the protocol channel of the stdio server.
    showSupportNotice: false,
  })
  translators.set(language, t)
  return t
}

/**
 * Fit the A4 page to a chat column and report its height, which is how an
 * MCP-UI host sizes the iframe (`ui-size-change`); without it the report shows
 * in a short frame with its own scrollbar.
 */
export function embedReportHtml(html: string): string {
  const style = '<style>body{background:#fff}.page{width:auto;max-width:210mm;min-height:0;margin:0 auto;box-shadow:none}</style>'
  const script = '<script>(function(){var post=function(){parent.postMessage({type:"ui-size-change",'
    + 'payload:{height:document.documentElement.scrollHeight}},"*")};'
    + 'new ResizeObserver(post).observe(document.documentElement);window.addEventListener("load",post)})()</script>'
  const withStyle = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : style + html
  return withStyle.includes('</body>') ? withStyle.replace('</body>', `${script}</body>`) : withStyle + script
}

const listItems = (items: { label: string; count: { label: string } }[]) =>
  items.map((i) => `${i.label}: ${i.count.label}`).join(', ')

/**
 * What the model reads: the report's figures as plain text. Counts are the
 * model's, already suppressed, so nothing below the threshold reaches the chat.
 */
export function summarizeReport(model: CohortReportModel): string {
  const lines = [`Report "${model.title}" — database ${model.databaseName}, level ${model.level}.`]
  if (model.description) lines.push(model.description)
  lines.push('', `Counts: ${listItems(model.kpis)}.`)
  if (model.source.databasePatients) lines.push(`Database patients (denominator): ${model.source.databasePatients.label}.`)
  if (model.flow.length) {
    lines.push('', 'Inclusion flow:')
    for (const f of model.flow) {
      lines.push(`  ${f.label}: ${f.units.label}${f.patients ? ` (${f.patients.label} patients)` : ''}`)
    }
  }
  if (model.criteria.length) {
    lines.push('', 'Criteria:')
    for (const c of model.criteria) lines.push(`${'  '.repeat(c.depth + 1)}${c.operator ? `${c.operator} ` : ''}${c.text}`)
  }
  if (model.concepts.length) {
    lines.push('', 'Concepts:')
    for (const c of model.concepts) {
      lines.push(`  ${c.name} (${c.table} ${c.conceptId}): ${c.patients.label} patients`
        + `${c.coverage ? ` (${c.coverage} %)` : ''}, ${c.rows.label} rows`)
    }
  }
  if (model.age.length) lines.push('', `Age at index: ${listItems(model.age)}.`)
  if (model.sex.length) lines.push(`Sex: ${listItems(model.sex)}.`)
  if (model.months.length) {
    lines.push(`Index dates: ${model.months[0].label} to ${model.months[model.months.length - 1].label}.`)
  }
  if (model.careUnits.length) lines.push(`Top care units: ${listItems(model.careUnits.slice(0, 5))}.`)
  if (model.eventTables.length) {
    lines.push(`Data per event table: ${model.eventTables.map((e) => `${e.label} ${e.rows.label} rows`).join(', ')}.`)
  }
  lines.push('', `Counts from 1 to ${model.threshold - 1} are shown as <${model.threshold}.`)
  return lines.join('\n')
}
