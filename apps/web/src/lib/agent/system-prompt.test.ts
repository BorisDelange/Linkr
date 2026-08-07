import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_OPTIONS,
  buildSystemPrompt,
  estimateTokens,
  type SystemPromptInput,
} from './system-prompt'

function input(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    dashboard: {
      dashboardName: 'ICU overview',
      activeTabId: 'tab_1',
      tabs: [
        { id: 'tab_1', name: 'Demographics' },
        { id: 'tab_2', name: 'Labs' },
      ],
      widgets: [{ id: 'wid_1', tabId: 'tab_1', name: 'Age' }],
    },
    datasets: [
      {
        id: 'ds_1',
        name: 'patients',
        columns: [
          { id: 'c1', name: 'age', type: 'number', order: 0 },
        ] as SystemPromptInput['datasets'][0]['columns'],
      },
    ],
    pluginSummaries: ['- plot-builder — Plot Builder: charts.'],
    projectContext: 'Cohort of 412 septic shock patients admitted in 2024.',
    options: DEFAULT_CONTEXT_OPTIONS,
    ...overrides,
  }
}

describe('buildSystemPrompt', () => {
  it('includes the dashboard state with ids and marks the active tab', () => {
    const prompt = buildSystemPrompt(input())
    expect(prompt).toContain('ICU overview')
    expect(prompt).toContain('tab_1 (active) — Demographics')
    expect(prompt).toContain('tab_2 — Labs')
  })

  it('lists datasets as one-line summaries, not full schemas', () => {
    // Full schemas measured ~4x the cost of the entire dashboard state and grow
    // with the project, so the model fetches columns via describe_dataset.
    const prompt = buildSystemPrompt(input())
    expect(prompt).toContain('ds_1 — patients')
    expect(prompt).toContain('1 columns')
    expect(prompt).not.toContain('age (number)')
    expect(prompt).toContain('describe_dataset')
    expect(prompt).toContain('plot-builder')
  })

  it('never lists widgets inline — only their count and how to fetch them', () => {
    // Widgets are many and rarely named in a request, so they are always fetched
    // on demand rather than paid for on every call.
    const prompt = buildSystemPrompt(input())
    expect(prompt).not.toContain('wid_1 in tab_1')
    expect(prompt).toContain('1 widget(s)')
    expect(prompt).toContain('describe_dashboard')
  })

  it('drops tab listing once it costs more than the tool that replaces it', () => {
    // Measured trade-off: a tool definition costs ~44 tokens once, a tab line ~8
    // each, so inline wins until roughly a dozen tabs.
    const tabs = Array.from({ length: 15 }, (_, i) => ({
      id: `tab_${i}`,
      name: `Tab ${i}`,
    }))
    const prompt = buildSystemPrompt(
      input({
        dashboard: {
          dashboardName: 'Big',
          activeTabId: 'tab_0',
          tabs,
          widgets: [],
        },
      })
    )
    expect(prompt).not.toContain('tab_14 — Tab 14')
    expect(prompt).toContain('15 tabs')
    expect(prompt).toContain('describe_dashboard')
  })

  it('omits the project context unless explicitly enabled', () => {
    // A README can carry cohort sizes and inclusion criteria, so it must never be
    // sent just because it exists.
    const prompt = buildSystemPrompt(input())
    expect(prompt).not.toContain('septic shock')

    const optedIn = buildSystemPrompt(
      input({ options: { ...DEFAULT_CONTEXT_OPTIONS, includeProjectContext: true } })
    )
    expect(optedIn).toContain('septic shock')
  })

  it('can drop dataset and plugin context', () => {
    const prompt = buildSystemPrompt(
      input({
        options: {
          includeDatasets: false,
          includePlugins: false,
          includeProjectContext: false,
        },
      })
    )
    expect(prompt).not.toContain('ds_1')
    expect(prompt).not.toContain('plot-builder')
    expect(prompt).toContain('ICU overview')
  })

  it('tells the model to ask rather than guess, and not to substitute actions', () => {
    const prompt = buildSystemPrompt(input())
    expect(prompt).toContain('ask one short question instead of guessing')
    expect(prompt).toContain('Do not substitute another action')
  })

  it('renders an empty dashboard without crashing', () => {
    const prompt = buildSystemPrompt(
      input({
        dashboard: {
          dashboardName: 'Empty',
          activeTabId: null,
          tabs: [],
          widgets: [],
        },
      })
    )
    expect(prompt).toContain('(none)')
  })
})

describe('estimateTokens', () => {
  it('scales with length', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})
