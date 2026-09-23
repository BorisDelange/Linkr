/** Where the user is: the defaults behind "this cohort", "here". */
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { READ, api, guard, text, type Server } from './shared.js'

export function registerContextTools(server: Server): void {
  server.registerTool('get_ui_context', {
    description:
      'Where the user currently is in Linkr: the project, the page, and the open cohort, dashboard (with '
      + 'its active tab) or dataset — in the browser tab they last focused. Call it when the request says '
      + '"this", "here" or names nothing: use these ids as defaults. Tools can still act anywhere; if nothing '
      + 'is open, or it is ambiguous, ask the user.',
    annotations: READ,
    inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  }, guard(async () => {
    const ctx = await api.getUiContext()
    if (!ctx) return text('No Linkr tab is open for this user: ask which project (list_projects) and item they mean.')
    const lines = Object.entries(ctx)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${String(v)}`)
    return text(lines.join('\n'))
  }))
}
