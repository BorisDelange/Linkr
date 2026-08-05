/**
 * Assembles what the copilot knows before it answers.
 *
 * Context is opt-in by source, not "everything we have": the project README can
 * legitimately contain clinical detail (cohort sizes, inclusion criteria, case
 * descriptions), so it is off by default and only added when the user turns it on
 * — unlike dataset schemas and plugin summaries, which carry no patient data.
 */
import { datasetsSummary, type DatasetContextInput } from './dataset-context'

export interface ContextOptions {
  /** Column names, types, labels, descriptions. No rows, ever. */
  includeDatasets: boolean
  /** One line per available plugin. */
  includePlugins: boolean
  /** Project README — may hold clinical detail, so it defaults to off. */
  includeProjectContext: boolean
}

export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  includeDatasets: true,
  includePlugins: true,
  includeProjectContext: false,
}

export interface DashboardStateSummary {
  dashboardName: string
  activeTabId: string | null
  tabs: { id: string; name: string }[]
  widgets: { id: string; tabId: string; name: string }[]
}

export interface SystemPromptInput {
  dashboard: DashboardStateSummary
  datasets: DatasetContextInput[]
  pluginSummaries: string[]
  projectContext?: string
  options: ContextOptions
}

const RULES = [
  'Use tools to change the dashboard. Never claim a change you did not make.',
  'Use exact ids. Never invent one.',
  'Call describe_dataset before choosing columns, describe_plugin before setting config.',
  'If ambiguous, ask one short question instead of guessing.',
  'If you cannot do it with these tools, say so. Do not substitute another action.',
].map((rule, index) => `${index + 1}. ${rule}`)

/**
 * Widget listing is capped: on a large dashboard the full list dominates the
 * prompt while the model usually acts on the current tab. Beyond this, only the
 * active tab's widgets are listed.
 */
const MAX_LISTED_WIDGETS = 12

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { dashboard, datasets, pluginSummaries, projectContext, options } = input
  const sections: string[] = [
    'You are a dashboard assistant in Linkr, a clinical data platform.',
    `Rules:\n${RULES.join('\n')}`,
  ]

  const tabs = dashboard.tabs
    .map((tab) => `  ${tab.id}${tab.id === dashboard.activeTabId ? ' (active)' : ''} — ${tab.name}`)
    .join('\n')

  const allWidgets = dashboard.widgets
  const listed =
    allWidgets.length > MAX_LISTED_WIDGETS
      ? allWidgets.filter((widget) => widget.tabId === dashboard.activeTabId)
      : allWidgets
  const widgets = listed
    .map((widget) => `  ${widget.id} in ${widget.tabId} — ${widget.name}`)
    .join('\n')
  const omitted = allWidgets.length - listed.length

  sections.push(
    [
      `Current dashboard: ${dashboard.dashboardName}`,
      'Tabs:',
      tabs || '  (none)',
      omitted > 0 ? `Widgets in the active tab (${omitted} more elsewhere):` : 'Widgets:',
      widgets || '  (none)',
    ].join('\n')
  )

  if (options.includeDatasets) {
    // Summaries only: full schemas measured ~4x the cost of the whole dashboard
    // state, and grow with the project rather than the request. The model calls
    // describe_dataset for the one it needs.
    sections.push(`Datasets (call describe_dataset for columns):\n${datasetsSummary(datasets)}`)
  }
  if (options.includePlugins && pluginSummaries.length) {
    sections.push(`Available plugins:\n${pluginSummaries.join('\n')}`)
  }
  if (options.includeProjectContext && projectContext?.trim()) {
    sections.push(`Project context:\n${projectContext.trim()}`)
  }

  return sections.join('\n\n')
}

/**
 * Rough token count for the context meter. Deliberately a heuristic: an exact
 * count needs the model's tokenizer, which differs per model and is not worth
 * shipping to show a gauge. ~4 chars per token holds well enough for English and
 * French prose to warn the user before they hit the window.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
