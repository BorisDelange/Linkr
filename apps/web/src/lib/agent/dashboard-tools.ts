/**
 * The dashboard copilot's tool surface: JSON Schema definitions for the LLM, and
 * a dispatcher that executes them against the dashboard store.
 *
 * Tools run CLIENT-side against the Zustand store, so a tool call re-renders the
 * dashboard exactly like a mouse click — that is what makes changes appear live
 * rather than needing a refresh. The LLM only ever names a tool and its args.
 *
 * The whitelist is load-bearing, not decorative. The batch-3 spike (see
 * docs/planning/ai-agents-plan.md) found that llama3.1:8b scored 12/12 on real
 * tasks but 0/3 on refusing an out-of-scope request: asked to delete patients, it
 * reached for the nearest available tool. Small models do this. So an unknown
 * tool name, or args that fail validation, are REJECTED here rather than being
 * coerced into something plausible.
 */
import type { DashboardWidgetSource } from '@/types'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** What the store needs to expose for the tools to run. Kept narrow on purpose. */
export interface ToolContext {
  dashboardId: string
  /** Tab the user is currently looking at — the default target. */
  activeTabId: string | null
  addTab: (dashboardId: string) => void
  updateTab: (tabId: string, changes: { name?: Record<string, string> }) => void
  addWidget: (
    tabId: string,
    source: DashboardWidgetSource,
    name: Record<string, string>,
    datasetFileId?: string | null
  ) => void
  updateWidgetSource: (widgetId: string, source: DashboardWidgetSource) => void
  updateWidgetLayout: (
    widgetId: string,
    layout: { x: number; y: number; w: number; h: number }
  ) => void
  /** Ids that exist right now, for validating what the model references. */
  tabIds: () => string[]
  widgetIds: () => string[]
  datasetIds: () => string[]
  /** Newest widget in a tab — how we resolve "the widget you just added". */
  lastWidgetIdInTab: (tabId: string) => string | null
  /** Newest tab on the dashboard, same idea. */
  lastTabId: () => string | null
  removeTab: (tabId: string) => void
  removeWidget: (widgetId: string) => void
  /** Display names, so a model naming "Tab 7" can be matched to its id. */
  tabName: (tabId: string) => string | null
  widgetName: (widgetId: string) => string | null
  /** Resolve a tab/widget referenced by its visible name rather than its id. */
  findTabByName: (name: string) => string | null
  findWidgetByName: (name: string) => string | null
  /** Full column schema for one dataset, fetched on demand. */
  describeDataset: (datasetId: string) => string | null
  locale: string
}

export interface ToolResult {
  ok: boolean
  /** Fed back to the model as the tool result, so it must be terse and factual. */
  message: string
  /** Set when the call was rejected rather than executed. */
  rejected?: boolean
  /** Set when the call needs the user to confirm before it runs. */
  needsConfirmation?: PendingAction
}

/** A destructive call held back until the user approves it. */
export interface PendingAction {
  tool: string
  args: Record<string, unknown>
  /** Human-readable description of what will happen, shown in the prompt. */
  summary: string
}

/** Tools that destroy user work, so they never run unprompted. */
const DESTRUCTIVE = new Set(['remove_tab', 'remove_widget'])

export function isDestructive(name: string): boolean {
  return DESTRUCTIVE.has(name)
}

/** The 12-column grid the dashboard uses; "half the screen" means w=6. */
const GRID_COLUMNS = 12
const DEFAULT_WIDGET_HEIGHT = 8

export const PLOT_BUILDER_ID = 'linkr-analysis-plot-builder'

export const DASHBOARD_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'add_tab',
      description: 'Create a tab and switch to it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tab title.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_widget',
      description: 'Add a chart widget to a tab.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Widget title.' },
          datasetId: { type: 'string', description: 'Dataset id.' },
          tabId: { type: 'string', description: 'Tab id. Omit for the current tab.' },
          config: {
            type: 'object',
            description: 'Plugin config, e.g. {"plotType":"histogram","xColumn":"age"}.',
          },
        },
        required: ['name', 'datasetId', 'config'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_widget',
      description: 'Change an existing widget config.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'Widget id. Omit for the last one.' },
          config: { type: 'object', description: 'Config fields to set.' },
        },
        required: ['config'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_layout',
      description: 'Position and size a widget on a 12-column grid.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'Widget id. Omit for the last one.' },
          x: { type: 'integer', description: 'Column offset from left, 0-11.' },
          y: { type: 'integer', description: 'Row offset from top.' },
          w: { type: 'integer', description: 'Width: 6 = half, 12 = full.' },
          h: { type: 'integer', description: 'Height in rows.' },
        },
        required: ['w'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_tab',
      description: 'Delete a tab and its widgets. User confirms first.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab id or name.' },
        },
        required: ['tabId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_widget',
      description: 'Delete a widget. User confirms first.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'Widget id or name.' },
        },
        required: ['widgetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_plugin',
      description: 'Get a plugin config fields. Use before configuring a widget.',
      parameters: {
        type: 'object',
        properties: {
          pluginId: { type: 'string', description: 'Plugin id.' },
        },
        required: ['pluginId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_dataset',
      description:
        'Get a dataset columns (names, types, descriptions). Use before choosing columns.',
      parameters: {
        type: 'object',
        properties: {
          datasetId: { type: 'string', description: 'Dataset id.' },
        },
        required: ['datasetId'],
      },
    },
  },
]

const TOOL_NAMES = new Set(DASHBOARD_TOOLS.map((t) => t.function.name))

export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.has(name)
}

function localizedName(value: string, locale: string): Record<string, string> {
  // Store both locales so the label is never blank in the other language; the
  // user typed their request in one language and we have no translation here.
  return { en: value, fr: value, [locale]: value }
}

function asInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null
}

/**
 * Execute one tool call. Never throws: a bad call becomes a rejected ToolResult
 * that is fed back to the model, which can then correct itself.
 */
export function runDashboardTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  describePlugin: (pluginId: string) => string | null,
  /** True when the user has approved a destructive call held back earlier. */
  confirmed = false
): ToolResult {
  if (!isKnownTool(name)) {
    return {
      ok: false,
      rejected: true,
      message: `Unknown tool "${name}". Available: ${[...TOOL_NAMES].join(', ')}.`,
    }
  }

  switch (name) {
    case 'add_tab': {
      const title = typeof args.name === 'string' ? args.name.trim() : ''
      if (!title) return { ok: false, rejected: true, message: 'A tab name is required.' }
      ctx.addTab(ctx.dashboardId)
      const tabId = ctx.lastTabId()
      if (!tabId) return { ok: false, message: 'Tab creation failed.' }
      ctx.updateTab(tabId, { name: localizedName(title, ctx.locale) })
      return { ok: true, message: `Created tab "${title}" (id ${tabId}).` }
    }

    case 'add_widget': {
      const title = typeof args.name === 'string' ? args.name.trim() : ''
      const datasetId = typeof args.datasetId === 'string' ? args.datasetId : ''
      const config = (args.config ?? {}) as Record<string, unknown>

      if (!title) return { ok: false, rejected: true, message: 'A widget name is required.' }
      if (!ctx.datasetIds().includes(datasetId)) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown dataset "${datasetId}". Available: ${ctx.datasetIds().join(', ') || 'none'}.`,
        }
      }

      const tabId = typeof args.tabId === 'string' && args.tabId ? args.tabId : ctx.activeTabId
      if (!tabId || !ctx.tabIds().includes(tabId)) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown tab "${tabId ?? ''}". Available: ${ctx.tabIds().join(', ') || 'none'}.`,
        }
      }

      const source: DashboardWidgetSource = {
        type: 'plugin',
        pluginId: PLOT_BUILDER_ID,
        config,
      }
      ctx.addWidget(tabId, source, localizedName(title, ctx.locale), datasetId)
      const widgetId = ctx.lastWidgetIdInTab(tabId)
      return {
        ok: true,
        message: `Added widget "${title}" (id ${widgetId ?? '?'}) to tab ${tabId}.`,
      }
    }

    case 'configure_widget': {
      const widgetId =
        typeof args.widgetId === 'string' && args.widgetId
          ? args.widgetId
          : ctx.activeTabId
            ? ctx.lastWidgetIdInTab(ctx.activeTabId)
            : null
      if (!widgetId || !ctx.widgetIds().includes(widgetId)) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown widget "${widgetId ?? ''}".`,
        }
      }
      const config = (args.config ?? {}) as Record<string, unknown>
      if (!Object.keys(config).length) {
        return { ok: false, rejected: true, message: 'No config fields given.' }
      }
      ctx.updateWidgetSource(widgetId, {
        type: 'plugin',
        pluginId: PLOT_BUILDER_ID,
        config,
      })
      return { ok: true, message: `Reconfigured widget ${widgetId}.` }
    }

    case 'set_layout': {
      const widgetId =
        typeof args.widgetId === 'string' && args.widgetId
          ? args.widgetId
          : ctx.activeTabId
            ? ctx.lastWidgetIdInTab(ctx.activeTabId)
            : null
      if (!widgetId || !ctx.widgetIds().includes(widgetId)) {
        return { ok: false, rejected: true, message: `Unknown widget "${widgetId ?? ''}".` }
      }
      const w = asInt(args.w)
      if (w == null || w < 1) {
        return { ok: false, rejected: true, message: 'w must be a positive integer.' }
      }
      // Clamp rather than reject: a model asking for w=16 on a 12-column grid
      // means "full width", and failing the call would be unhelpful.
      const width = Math.min(w, GRID_COLUMNS)
      const x = Math.min(Math.max(asInt(args.x) ?? 0, 0), GRID_COLUMNS - width)
      const y = Math.max(asInt(args.y) ?? 0, 0)
      const h = Math.max(asInt(args.h) ?? DEFAULT_WIDGET_HEIGHT, 1)
      ctx.updateWidgetLayout(widgetId, { x, y, w: width, h })
      return { ok: true, message: `Set layout of ${widgetId} to x=${x} y=${y} w=${width} h=${h}.` }
    }

    case 'remove_tab': {
      // Models routinely pass the visible name ("Tab 7") where an id belongs, so
      // accept either rather than rejecting a request the user clearly meant.
      const raw = typeof args.tabId === 'string' ? args.tabId : ''
      const tabId = ctx.tabIds().includes(raw) ? raw : ctx.findTabByName(raw)
      if (!tabId) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown tab "${raw}". Available: ${ctx.tabIds().join(', ') || 'none'}.`,
        }
      }
      if (!confirmed) {
        return {
          ok: false,
          message: `Waiting for the user to confirm deleting tab "${ctx.tabName(tabId) ?? tabId}".`,
          needsConfirmation: {
            tool: name,
            args: { tabId },
            summary: ctx.tabName(tabId) ?? tabId,
          },
        }
      }
      ctx.removeTab(tabId)
      return { ok: true, message: `Deleted tab ${tabId}.` }
    }

    case 'remove_widget': {
      const raw = typeof args.widgetId === 'string' ? args.widgetId : ''
      const widgetId = ctx.widgetIds().includes(raw) ? raw : ctx.findWidgetByName(raw)
      if (!widgetId) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown widget "${raw}". Available: ${ctx.widgetIds().join(', ') || 'none'}.`,
        }
      }
      if (!confirmed) {
        return {
          ok: false,
          message: `Waiting for the user to confirm deleting widget "${ctx.widgetName(widgetId) ?? widgetId}".`,
          needsConfirmation: {
            tool: name,
            args: { widgetId },
            summary: ctx.widgetName(widgetId) ?? widgetId,
          },
        }
      }
      ctx.removeWidget(widgetId)
      return { ok: true, message: `Deleted widget ${widgetId}.` }
    }

    case 'describe_plugin': {
      const pluginId = typeof args.pluginId === 'string' ? args.pluginId : ''
      const doc = describePlugin(pluginId)
      if (!doc) {
        return { ok: false, rejected: true, message: `Unknown plugin "${pluginId}".` }
      }
      return { ok: true, message: doc }
    }

    case 'describe_dataset': {
      const datasetId = typeof args.datasetId === 'string' ? args.datasetId : ''
      const doc = ctx.describeDataset(datasetId)
      if (!doc) {
        return {
          ok: false,
          rejected: true,
          message: `Unknown dataset "${datasetId}". Available: ${ctx.datasetIds().join(', ') || 'none'}.`,
        }
      }
      return { ok: true, message: doc }
    }

    default:
      return { ok: false, rejected: true, message: `Tool "${name}" is not implemented.` }
  }
}
