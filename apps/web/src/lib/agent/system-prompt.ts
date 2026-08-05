/**
 * Assembles what the copilot knows before it answers.
 *
 * Context is opt-in by source, not "everything we have": the project README can
 * legitimately contain clinical detail (cohort sizes, inclusion criteria, case
 * descriptions), so it is off by default and only added when the user turns it on
 * — unlike dataset schemas and plugin summaries, which carry no patient data.
 */
import { datasetsContext, type DatasetContextInput } from './dataset-context'

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
  'Use the tools to change the dashboard; do not describe changes you have not made.',
  'Reference ids exactly as given. Never invent a tab, widget, dataset or column id.',
  'Call describe_plugin before configuring a widget if you are unsure of a field name.',
  'If the request is ambiguous (e.g. the column exists in several datasets), ask one short question instead of guessing.',
  'If a request cannot be done with the available tools, say so plainly. Do not substitute a different action.',
].map((rule, index) => `${index + 1}. ${rule}`)

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { dashboard, datasets, pluginSummaries, projectContext, options } = input
  const sections: string[] = [
    'You are a dashboard assistant inside Linkr, a clinical data platform. ' +
      'You help the user build and arrange dashboard widgets.',
    `Rules:\n${RULES.join('\n')}`,
  ]

  const tabs = dashboard.tabs
    .map((tab) => `  ${tab.id}${tab.id === dashboard.activeTabId ? ' (active)' : ''} — ${tab.name}`)
    .join('\n')
  const widgets = dashboard.widgets
    .map((widget) => `  ${widget.id} in ${widget.tabId} — ${widget.name}`)
    .join('\n')
  sections.push(
    [
      `Current dashboard: ${dashboard.dashboardName}`,
      'Tabs:',
      tabs || '  (none)',
      'Widgets:',
      widgets || '  (none)',
    ].join('\n')
  )

  if (options.includeDatasets) {
    sections.push(`Available datasets (schema only):\n${datasetsContext(datasets)}`)
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
