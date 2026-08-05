import { describe, expect, it, vi } from 'vitest'
import {
  isDestructive,
  isKnownTool,
  runDashboardTool,
  type ToolContext,
} from './dashboard-tools'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    dashboardId: 'dash_1',
    activeTabId: 'tab_1',
    addTab: vi.fn(),
    updateTab: vi.fn(),
    addWidget: vi.fn(),
    updateWidgetSource: vi.fn(),
    updateWidgetLayout: vi.fn(),
    tabIds: () => ['tab_1', 'tab_2'],
    widgetIds: () => ['wid_1'],
    datasetIds: () => ['ds_1'],
    lastWidgetIdInTab: () => 'wid_1',
    lastTabId: () => 'tab_new',
    removeTab: vi.fn(),
    removeWidget: vi.fn(),
    tabName: (id) => (id === 'tab_1' ? 'Overview' : null),
    widgetName: (id) => (id === 'wid_1' ? 'Age' : null),
    findTabByName: (name) => (name.toLowerCase() === 'overview' ? 'tab_1' : null),
    findWidgetByName: (name) => (name.toLowerCase() === 'age' ? 'wid_1' : null),
    locale: 'fr',
    ...overrides,
  }
}

const noDoc = () => null

describe('tool whitelist', () => {
  it('rejects an unknown tool name', () => {
    // The spike showed a small model reaches for a nonexistent/nearest tool when
    // asked something out of scope. That must never execute.
    const result = runDashboardTool('delete_patients', { age: 80 }, ctx(), noDoc)
    expect(result.ok).toBe(false)
    expect(result.rejected).toBe(true)
    expect(result.message).toContain('Unknown tool')
  })

  it('knows only the declared tools', () => {
    expect(isKnownTool('add_widget')).toBe(true)
    expect(isKnownTool('drop_table')).toBe(false)
  })
})

describe('add_tab', () => {
  it('creates the tab then names it', () => {
    const c = ctx()
    const result = runDashboardTool('add_tab', { name: 'Outcomes' }, c, noDoc)
    expect(result.ok).toBe(true)
    expect(c.addTab).toHaveBeenCalledWith('dash_1')
    expect(c.updateTab).toHaveBeenCalledWith('tab_new', {
      name: expect.objectContaining({ en: 'Outcomes', fr: 'Outcomes' }),
    })
    expect(result.message).toContain('tab_new')
  })

  it('rejects a blank name', () => {
    const result = runDashboardTool('add_tab', { name: '  ' }, ctx(), noDoc)
    expect(result.rejected).toBe(true)
  })
})

describe('add_widget', () => {
  it('adds a plot-builder widget with the given config', () => {
    const c = ctx()
    const result = runDashboardTool(
      'add_widget',
      {
        name: 'Age distribution',
        datasetId: 'ds_1',
        config: { plotType: 'histogram', xColumn: 'age' },
      },
      c,
      noDoc
    )
    expect(result.ok).toBe(true)
    expect(c.addWidget).toHaveBeenCalledWith(
      'tab_1',
      expect.objectContaining({
        type: 'plugin',
        config: { plotType: 'histogram', xColumn: 'age' },
      }),
      expect.any(Object),
      'ds_1'
    )
  })

  it('defaults to the active tab when tabId is omitted', () => {
    const c = ctx({ activeTabId: 'tab_2' })
    runDashboardTool(
      'add_widget',
      { name: 'W', datasetId: 'ds_1', config: {} },
      c,
      noDoc
    )
    expect(c.addWidget).toHaveBeenCalledWith(
      'tab_2',
      expect.anything(),
      expect.anything(),
      'ds_1'
    )
  })

  it('rejects a hallucinated dataset id and lists the real ones', () => {
    const c = ctx()
    const result = runDashboardTool(
      'add_widget',
      { name: 'W', datasetId: 'ds_does_not_exist', config: {} },
      c,
      noDoc
    )
    expect(result.rejected).toBe(true)
    expect(result.message).toContain('ds_1')
    expect(c.addWidget).not.toHaveBeenCalled()
  })

  it('rejects a hallucinated tab id', () => {
    const c = ctx()
    const result = runDashboardTool(
      'add_widget',
      { name: 'W', datasetId: 'ds_1', config: {}, tabId: 'tab_nope' },
      c,
      noDoc
    )
    expect(result.rejected).toBe(true)
    expect(c.addWidget).not.toHaveBeenCalled()
  })
})

describe('configure_widget', () => {
  it('targets the last added widget when widgetId is omitted', () => {
    const c = ctx()
    const result = runDashboardTool(
      'configure_widget',
      { config: { plotType: 'boxplot' } },
      c,
      noDoc
    )
    expect(result.ok).toBe(true)
    expect(c.updateWidgetSource).toHaveBeenCalledWith(
      'wid_1',
      expect.objectContaining({ config: { plotType: 'boxplot' } })
    )
  })

  it('rejects an empty config', () => {
    const result = runDashboardTool('configure_widget', { config: {} }, ctx(), noDoc)
    expect(result.rejected).toBe(true)
  })

  it('rejects an unknown widget', () => {
    const result = runDashboardTool(
      'configure_widget',
      { widgetId: 'wid_x', config: { plotType: 'bar' } },
      ctx(),
      noDoc
    )
    expect(result.rejected).toBe(true)
  })
})

describe('set_layout', () => {
  it('sets a half-width widget', () => {
    const c = ctx()
    const result = runDashboardTool('set_layout', { w: 6, x: 0, y: 0, h: 8 }, c, noDoc)
    expect(result.ok).toBe(true)
    expect(c.updateWidgetLayout).toHaveBeenCalledWith('wid_1', { x: 0, y: 0, w: 6, h: 8 })
  })

  it('clamps a width wider than the grid instead of failing', () => {
    const c = ctx()
    runDashboardTool('set_layout', { w: 16 }, c, noDoc)
    expect(c.updateWidgetLayout).toHaveBeenCalledWith(
      'wid_1',
      expect.objectContaining({ w: 12 })
    )
  })

  it('keeps the widget inside the grid when x would overflow', () => {
    const c = ctx()
    runDashboardTool('set_layout', { w: 6, x: 10 }, c, noDoc)
    expect(c.updateWidgetLayout).toHaveBeenCalledWith(
      'wid_1',
      expect.objectContaining({ x: 6, w: 6 })
    )
  })

  it('accepts numbers arriving as strings', () => {
    const c = ctx()
    runDashboardTool('set_layout', { w: '6', h: '4' }, c, noDoc)
    expect(c.updateWidgetLayout).toHaveBeenCalledWith(
      'wid_1',
      expect.objectContaining({ w: 6, h: 4 })
    )
  })

  it('rejects a non-numeric width', () => {
    const result = runDashboardTool('set_layout', { w: 'wide' }, ctx(), noDoc)
    expect(result.rejected).toBe(true)
  })
})

describe('destructive tools', () => {
  it('holds back a tab deletion until confirmed', () => {
    const c = ctx()
    const result = runDashboardTool('remove_tab', { tabId: 'tab_1' }, c, noDoc)
    expect(result.ok).toBe(false)
    expect(result.needsConfirmation).toEqual({
      tool: 'remove_tab',
      args: { tabId: 'tab_1' },
      summary: 'Overview',
    })
    expect(c.removeTab).not.toHaveBeenCalled()
  })

  it('deletes the tab once confirmed', () => {
    const c = ctx()
    const result = runDashboardTool('remove_tab', { tabId: 'tab_1' }, c, noDoc, true)
    expect(result.ok).toBe(true)
    expect(c.removeTab).toHaveBeenCalledWith('tab_1')
  })

  it('resolves a tab referenced by its visible name', () => {
    // Models routinely pass "Tab 7" where an id belongs — the exact failure the
    // user hit, which silently did nothing.
    const c = ctx()
    const result = runDashboardTool('remove_tab', { tabId: 'Overview' }, c, noDoc, true)
    expect(result.ok).toBe(true)
    expect(c.removeTab).toHaveBeenCalledWith('tab_1')
  })

  it('rejects a tab that matches neither id nor name', () => {
    const c = ctx()
    const result = runDashboardTool('remove_tab', { tabId: 'Tab 7' }, c, noDoc, true)
    expect(result.rejected).toBe(true)
    expect(c.removeTab).not.toHaveBeenCalled()
  })

  it('holds back a widget deletion until confirmed', () => {
    const c = ctx()
    const held = runDashboardTool('remove_widget', { widgetId: 'wid_1' }, c, noDoc)
    expect(held.needsConfirmation?.summary).toBe('Age')
    expect(c.removeWidget).not.toHaveBeenCalled()

    const done = runDashboardTool('remove_widget', { widgetId: 'wid_1' }, c, noDoc, true)
    expect(done.ok).toBe(true)
    expect(c.removeWidget).toHaveBeenCalledWith('wid_1')
  })

  it('flags which tools are destructive', () => {
    expect(isDestructive('remove_tab')).toBe(true)
    expect(isDestructive('remove_widget')).toBe(true)
    expect(isDestructive('add_widget')).toBe(false)
  })
})

describe('describe_plugin', () => {
  it('returns the derived doc', () => {
    const result = runDashboardTool(
      'describe_plugin',
      { pluginId: 'linkr-analysis-plot-builder' },
      ctx(),
      () => 'plot-builder\n  plotType (select)'
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('plotType')
  })

  it('rejects an unknown plugin', () => {
    const result = runDashboardTool('describe_plugin', { pluginId: 'nope' }, ctx(), noDoc)
    expect(result.rejected).toBe(true)
  })
})
